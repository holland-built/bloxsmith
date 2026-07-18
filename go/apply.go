package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/minio/selfupdate"
)

// Phase 3 self-update apply path. The Go self-updater is SAFE — it only
// downloads and swaps its OWN binary (no docker socket, no privilege) — so the
// passive-banner constraint that bound the Docker build is lifted here.
//
// Flow: latest GitHub release -> pick the goreleaser archive asset for THIS
// GOOS/GOARCH -> verify its sha256 against the release checksums.txt -> extract
// the binary from the archive -> minio/selfupdate.Apply (atomic swap, Windows
// rename-dance handled by the library) -> graceful re-exec so the new binary
// runs. On any failure the old binary is left in place (selfupdate rolls back).

// startTime + applyCooldown port _APPLY_COOLDOWN (server.py:73): apply is
// refused for the first 60s after startup so a crash-loop can't self-update.
var startTime = time.Now()

const applyCooldown = 60 * time.Second

// updateProgress is the pollable {phase,pct} status the frontend reads from
// GET /api/update/status. It replaces the old Python /api/update/status shape
// with a simpler, self-explanatory one.
type updateProgress struct {
	mu      sync.Mutex
	Phase   string // idle | starting | downloading | verifying | applying | restarting | done | error
	Pct     int
	Err     string
	Version string // target release once known
	running bool
}

var progress = &updateProgress{Phase: "idle"}

func (p *updateProgress) set(phase string, pct int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Phase, p.Pct = phase, pct
}

func (p *updateProgress) setVersion(v string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Version = v
}

func (p *updateProgress) fail(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.Phase, p.Err, p.running = "error", err.Error(), false
}

// begin flips running true iff no apply is already in flight (returns false when
// one is). Prevents concurrent applies stepping on the binary swap.
func (p *updateProgress) begin() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return false
	}
	p.running, p.Phase, p.Pct, p.Err = true, "starting", 1, ""
	return true
}

func (p *updateProgress) snapshot() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return map[string]any{
		"phase": p.Phase, "pct": p.Pct, "error": p.Err,
		"version": p.Version, "running": p.running,
	}
}

// ghRelease is the slice of the GitHub Releases API we consume.
type ghRelease struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func latestRelease() (ghRelease, error) {
	var rel ghRelease
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", appRepo), nil)
	req.Header.Set("User-Agent", "bloxsmith")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return rel, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return rel, fmt.Errorf("github releases: HTTP %d", resp.StatusCode)
	}
	return rel, json.NewDecoder(resp.Body).Decode(&rel)
}

// archiveAssetName reproduces the goreleaser archive name_template in
// go/.goreleaser.yaml for THIS platform. darwin ships one universal archive
// (universal_binaries: replace) — arch-less; linux/windows are per-arch;
// windows is a .zip, everything else .tar.gz. ver is the release tag with any
// leading "v" stripped ({{ .Version }} == 1.0.<n>, tag_name == v1.0.<n>).
func archiveAssetName(ver string) string {
	v := strings.TrimPrefix(ver, "v")
	if runtime.GOOS == "darwin" {
		return fmt.Sprintf("bloxsmith_%s_macOS_universal.tar.gz", v)
	}
	ext := "tar.gz"
	if runtime.GOOS == "windows" {
		ext = "zip"
	}
	return fmt.Sprintf("bloxsmith_%s_%s_%s.%s", v, runtime.GOOS, runtime.GOARCH, ext)
}

func assetURL(rel ghRelease, name string) string {
	for _, a := range rel.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func httpGetBytes(url string) ([]byte, error) {
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// checksumFor pulls the sha256 hex for a filename out of a goreleaser
// checksums.txt ("<hex>  <filename>" per line).
func checksumFor(sums []byte, filename string) string {
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == filename {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

// extractBinary reads the bloxsmith executable out of the downloaded archive.
// tar.gz for macOS/Linux, zip for Windows (where the file is bloxsmith.exe).
func extractBinary(archive []byte, isZip bool) ([]byte, error) {
	want := "bloxsmith"
	if runtime.GOOS == "windows" {
		want = "bloxsmith.exe"
	}
	if isZip {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if baseName(f.Name) == want {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
		return nil, fmt.Errorf("%s not found in archive", want)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if baseName(hdr.Name) == want {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("%s not found in archive", want)
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// applyLatest runs the whole download -> verify -> swap for the newest release.
// It advances updateProgress so the frontend can poll GET /api/update/status.
func applyLatest() error {
	progress.set("checking", 5)
	rel, err := latestRelease()
	if err != nil {
		return err
	}
	if rel.Tag == "" {
		return fmt.Errorf("no release tag found")
	}
	progress.setVersion(rel.Tag)

	archName := archiveAssetName(rel.Tag)
	archAsset := assetURL(rel, archName)
	sumAsset := assetURL(rel, "checksums.txt")
	if archAsset == "" {
		return fmt.Errorf("release %s has no asset %q for this platform", rel.Tag, archName)
	}
	if sumAsset == "" {
		return fmt.Errorf("release %s has no checksums.txt", rel.Tag)
	}

	progress.set("downloading", 25)
	archBytes, err := httpGetBytes(archAsset)
	if err != nil {
		return err
	}
	sums, err := httpGetBytes(sumAsset)
	if err != nil {
		return err
	}

	progress.set("verifying", 55)
	want := checksumFor(sums, archName)
	if want == "" {
		return fmt.Errorf("checksums.txt has no entry for %s", archName)
	}
	sum := sha256.Sum256(archBytes)
	if got := hex.EncodeToString(sum[:]); got != want {
		return fmt.Errorf("checksum mismatch: got %s want %s", got, want)
	}

	bin, err := extractBinary(archBytes, runtime.GOOS == "windows")
	if err != nil {
		return err
	}

	// selfupdate.Apply writes the new binary next to the running exe and does an
	// atomic rename swap. On Windows it moves the still-running .exe aside first
	// (the ".old" rename dance) so the replace succeeds while the file is locked.
	// On any failure it rolls the old binary back into place.
	progress.set("applying", 80)
	if err := selfupdate.Apply(bytes.NewReader(bin), selfupdate.Options{}); err != nil {
		if rerr := selfupdate.RollbackError(err); rerr != nil {
			return fmt.Errorf("apply failed AND rollback failed: %v (rollback: %v)", err, rerr)
		}
		return fmt.Errorf("apply failed, old binary restored: %v", err)
	}

	progress.set("restarting", 95)
	progress.set("done", 100)
	// Graceful hand-off: spawn the freshly-swapped binary, then exit so it takes
	// over the port. Deferred slightly so the /api/update/apply response and a
	// final /status poll can complete first.
	go func() {
		time.Sleep(750 * time.Millisecond)
		restart()
	}()
	return nil
}

// restart re-execs the (now updated) binary and exits the current process. A
// spawn+exit (rather than syscall.Exec) keeps the code identical on Windows,
// where exec-in-place is unavailable.
func restart() {
	exe, err := os.Executable()
	if err != nil {
		os.Exit(0)
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	cmd.Env = os.Environ()
	_ = cmd.Start()
	os.Exit(0)
}

// applyUpdateHandler backs POST /api/update/apply. The admin RBAC gate + audit
// entry are applied by the server wrapper before this runs. It honors the
// startup cooldown, refuses concurrent applies, kicks the download off in the
// background, and returns immediately so the frontend can poll /status.
func applyUpdateHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if left := applyCooldown - time.Since(startTime); left > 0 {
		w.WriteHeader(http.StatusTooEarly) // 425
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": false, "error": "update cooling down after startup",
			"cooldown": int(left.Seconds()) + 1,
		})
		return
	}
	if !progress.begin() {
		w.WriteHeader(http.StatusConflict) // 409
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "update already in progress"})
		return
	}
	go func() {
		if err := applyLatest(); err != nil {
			progress.fail(err)
		}
	}()
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "phase": "starting"})
}

// updateProgressHandler backs GET /api/update/status: the pollable {phase,pct}.
func updateProgressHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(progress.snapshot())
}

// runUpdateCLI is the `bloxsmith update` subcommand (headless servers, no
// button): same download+verify+swap+exit, driven from the command line.
func runUpdateCLI(checkOnly bool) int {
	st, err := checkUpdate()
	if err != nil {
		fmt.Fprintln(os.Stderr, "update check failed:", err)
		return 1
	}
	if !st.Available {
		fmt.Printf("bloxsmith %s is up to date (latest %s)\n", st.Current, st.Latest)
		return 0
	}
	fmt.Printf("update available: %s -> %s\n", st.Current, st.Latest)
	if checkOnly {
		return 0
	}
	fmt.Println("downloading and applying...")
	if err := applyLatest(); err != nil {
		fmt.Fprintln(os.Stderr, "update failed (old binary kept):", err)
		return 1
	}
	fmt.Println("updated to", st.Latest, "— restarting")
	return 0
}
