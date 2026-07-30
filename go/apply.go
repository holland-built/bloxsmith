package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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

// Size caps for the self-update download/extract path. A malicious or oversized
// release asset (or a decompression bomb) must not be able to exhaust memory,
// so every read is bounded.
const (
	maxArchiveBytes        = 200 << 20 // compressed archive
	maxChecksumBytes       = 4 << 20   // checksums.txt
	maxSignatureBytes      = 4 << 10   // checksums.txt.ed25519 (base64 of 64 bytes)
	maxJSONBytes           = 64 << 20  // GitHub release JSON
	maxBinaryBytes         = 200 << 20 // a single extracted file
	maxTemplateFileBytes   = 4 << 20   // a single template file (small YAML)
	maxTemplatesTotalBytes = 64 << 20  // all template files combined
)

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

// latestRelease uses githubAPIBase (update.go:20), the same seam checkUpdate
// uses, rather than a hardcoded host. Beyond making this testable: the two
// functions fetching the same endpoint used to disagree about where it is —
// anything that repointed the base (a proxy, a mirror, GitHub Enterprise)
// would have moved the update CHECK without moving the update APPLY.
func latestRelease() (ghRelease, error) {
	var rel ghRelease
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("%s/repos/%s/releases/latest", githubAPIBase, appRepo), nil)
	req.Header.Set("User-Agent", "bloxsmith")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return rel, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		// This is the exact path the 2026-07-30 live incident hit: applyLatest
		// -> latestRelease -> progress.fail(err) -> GET /api/update/status's
		// "error" field, with the raw body previously nowhere at all (the old
		// "github releases: HTTP 403" didn't even carry it). Bound the read,
		// send the raw body to the server log, and hand the caller the plain
		// sentence githubFailureDetail builds — same helper checkUpdate uses,
		// so the two GitHub-releases call sites can't drift into disagreeing
		// about what a given status means.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrBodySnippet+1))
		s := string(snippet)
		if len(s) > maxErrBodySnippet {
			s = s[:maxErrBodySnippet] + "..."
		}
		log.Printf("latestRelease: github releases API returned HTTP %d: %s", resp.StatusCode, s)
		return rel, fmt.Errorf("%s", githubFailureDetail(resp, s))
	}
	return rel, json.NewDecoder(io.LimitReader(resp.Body, maxJSONBytes)).Decode(&rel)
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

func httpGetBytes(url string, max int64) ([]byte, error) {
	resp, err := (&http.Client{Timeout: 120 * time.Second}).Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	// Read at most max+1 so we can distinguish "exactly at cap" from "over cap"
	// and reject oversized assets instead of silently truncating them.
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("download %s exceeds size cap of %d bytes", url, max)
	}
	return data, nil
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
				if f.UncompressedSize64 > maxBinaryBytes {
					return nil, fmt.Errorf("archive entry %s too large (%d bytes)", f.Name, f.UncompressedSize64)
				}
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return readCapped(rc, f.Name)
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
			if hdr.Size > maxBinaryBytes {
				return nil, fmt.Errorf("archive entry %s too large (%d bytes)", hdr.Name, hdr.Size)
			}
			return readCapped(tr, hdr.Name)
		}
	}
	return nil, fmt.Errorf("%s not found in archive", want)
}

// readCapped reads r with a hard byte cap so a lying archive header (declared
// size small, actual stream huge) still can't exhaust memory during extraction.
func readCapped(r io.Reader, name string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBinaryBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBinaryBytes {
		return nil, fmt.Errorf("archive entry %s exceeds size cap of %d bytes", name, int64(maxBinaryBytes))
	}
	return data, nil
}

func baseName(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// extractTemplates pulls every "templates/…" entry out of the downloaded
// archive and installs it under destDir/templates, atomically replacing
// whatever was there before (and pruning templates removed upstream). It
// extracts into a fresh destDir/templates.new sibling first and only swaps
// that into place once extraction fully succeeds; on ANY error the temp dir
// is removed and the existing templates/ is left untouched. This is a
// best-effort refresh called from applyLatest after the binary swap — the
// archive itself is already checksum-verified, but entry paths are still
// validated (defense in depth) and every read is size-capped.
func extractTemplates(archive []byte, isZip bool, destDir string) error {
	tmpDir := filepath.Join(destDir, "templates.new")
	if err := os.RemoveAll(tmpDir); err != nil {
		return fmt.Errorf("clearing %s: %w", tmpDir, err)
	}
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}

	var total int64
	write := func(entryPath string, r io.Reader, declaredSize int64) error {
		rel, err := safeTemplateRel(entryPath)
		if err != nil {
			return err
		}
		if declaredSize > maxTemplateFileBytes {
			return fmt.Errorf("template entry %s too large (%d bytes)", entryPath, declaredSize)
		}
		data, err := io.ReadAll(io.LimitReader(r, maxTemplateFileBytes+1))
		if err != nil {
			return err
		}
		if int64(len(data)) > maxTemplateFileBytes {
			return fmt.Errorf("template entry %s exceeds size cap of %d bytes", entryPath, int64(maxTemplateFileBytes))
		}
		total += int64(len(data))
		if total > maxTemplatesTotalBytes {
			return fmt.Errorf("templates total exceeds size cap of %d bytes", int64(maxTemplatesTotalBytes))
		}
		dest := filepath.Join(tmpDir, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	}

	var extractErr error
	if isZip {
		extractErr = extractTemplatesZip(archive, write)
	} else {
		extractErr = extractTemplatesTarGz(archive, write)
	}
	if extractErr != nil {
		_ = os.RemoveAll(tmpDir)
		return extractErr
	}

	final := filepath.Join(destDir, "templates")
	if err := os.RemoveAll(final); err != nil {
		_ = os.RemoveAll(tmpDir)
		return err
	}
	if err := os.Rename(tmpDir, final); err != nil {
		_ = os.RemoveAll(tmpDir)
		return err
	}
	return nil
}

// safeTemplateRel strips the "templates/" prefix from a slash-normalized
// archive entry path and returns its path relative to the templates root,
// rejecting absolute paths and any path that escapes the root via "..".
func safeTemplateRel(entryPath string) (string, error) {
	rel := strings.TrimPrefix(entryPath, "templates/")
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("archive entry %s escapes templates root", entryPath)
	}
	return clean, nil
}

// extractTemplatesZip walks a zip archive, invoking write for every regular
// file entry under templates/. Directory entries (trailing "/") are skipped.
func extractTemplatesZip(archive []byte, write func(entryPath string, r io.Reader, size int64) error) error {
	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		norm := strings.ReplaceAll(f.Name, "\\", "/")
		if !strings.HasPrefix(norm, "templates/") || strings.HasSuffix(norm, "/") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		err = write(norm, rc, int64(f.UncompressedSize64))
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// extractTemplatesTarGz walks a tar.gz archive, invoking write for every
// regular file entry under templates/. Directory (and other non-regular)
// entries are skipped.
func extractTemplatesTarGz(archive []byte, write func(entryPath string, r io.Reader, size int64) error) error {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		norm := strings.ReplaceAll(hdr.Name, "\\", "/")
		if hdr.Typeflag != tar.TypeReg || !strings.HasPrefix(norm, "templates/") {
			continue
		}
		if err := write(norm, tr, hdr.Size); err != nil {
			return err
		}
	}
	return nil
}

// fetchVerifiedBinary is the download -> verify signature -> verify checksum
// -> extract seam pulled out of applyLatest so a test can exercise it without
// ever reaching selfupdate.Apply or restart(). It returns the extracted
// bloxsmith binary and the raw archive bytes (the caller still needs the
// latter for extractTemplates).
func fetchVerifiedBinary(archAsset, sumAsset, sigAsset, archName string) (bin []byte, archBytes []byte, err error) {
	progress.set("downloading", 25)
	archBytes, err = httpGetBytes(archAsset, maxArchiveBytes)
	if err != nil {
		return nil, nil, err
	}
	sums, err := httpGetBytes(sumAsset, maxChecksumBytes)
	if err != nil {
		return nil, nil, err
	}

	sigBytes, err := httpGetBytes(sigAsset, maxSignatureBytes)
	if err != nil {
		return nil, nil, err
	}

	progress.set("verifying", 55)
	// The signature comes FIRST. Verifying the archive against checksums.txt is
	// worthless until we know checksums.txt is ours: an attacker who can replace
	// the tarball can replace the checksum sitting beside it, which is precisely
	// the gap the compiled-in public key closes (see signing.go).
	if err := verifyReleaseSignature(sums, sigBytes); err != nil {
		return nil, nil, err
	}
	want := checksumFor(sums, archName)
	if want == "" {
		return nil, nil, fmt.Errorf("checksums.txt has no entry for %s", archName)
	}
	sum := sha256.Sum256(archBytes)
	if got := hex.EncodeToString(sum[:]); got != want {
		return nil, nil, fmt.Errorf("checksum mismatch: got %s want %s", got, want)
	}

	bin, err = extractBinary(archBytes, runtime.GOOS == "windows")
	if err != nil {
		return nil, nil, err
	}
	return bin, archBytes, nil
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
	// Downgrade guard: only apply a release strictly newer than the running
	// binary. Without this the update button would happily re-install the same
	// version or roll BACK to an older "latest" — the CLI already gates on this
	// via checkUpdate/verN, so match it here for the HTTP apply path.
	if verN(rel.Tag) < 0 || verN(rel.Tag) <= verN(version) {
		return fmt.Errorf("already up to date (current %s, latest %s)", version, rel.Tag)
	}
	progress.setVersion(rel.Tag)

	archName := archiveAssetName(rel.Tag)
	archAsset := assetURL(rel, archName)
	sumAsset := assetURL(rel, "checksums.txt")
	sigAsset := assetURL(rel, releaseSigAssetName)
	if archAsset == "" {
		return fmt.Errorf("release %s has no asset %q for this platform", rel.Tag, archName)
	}
	if sumAsset == "" {
		return fmt.Errorf("release %s has no checksums.txt", rel.Tag)
	}
	// Refusing outright is deliberate. A missing signature is exactly what an
	// attacker who can write release assets would arrange, so treating it as
	// "sign it if you can, otherwise carry on" would leave the checksum
	// unanchored again and make the whole control decorative. CI fails the
	// release rather than publishing without one, so this can only fire on a
	// tampered release — or on one this key was never meant to validate.
	if sigAsset == "" {
		return fmt.Errorf("release %s is not signed (no %s) — refusing to self-update; "+
			"reinstall deliberately with scripts/install.sh if this is expected",
			rel.Tag, releaseSigAssetName)
	}

	bin, archBytes, err := fetchVerifiedBinary(archAsset, sumAsset, sigAsset, archName)
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
		// RollbackError==nil means the rollback either succeeded OR was never needed
		// (the swap hadn't committed) — either way the old binary is still in place.
		return fmt.Errorf("apply failed; old binary unchanged or restored: %v", err)
	}

	// Best-effort templates refresh: the archive also carries templates/, which
	// extractBinary above never touched, so a self-update alone never refreshed
	// them. The binary is already swapped at this point, so any failure here
	// must not fail the overall update — it's silently retried on the next
	// release.
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	_ = extractTemplates(archBytes, runtime.GOOS == "windows", filepath.Dir(exe))

	progress.set("restarting", 95)
	// Graceful hand-off: spawn the freshly-swapped binary, and only once it has
	// actually launched do we release our listen socket and exit so it can take
	// over the port. Deferred slightly so the /api/update/apply response and a
	// final /status poll can complete first.
	go func() {
		// A panic in the hand-off (before restart() reports its own spawn errors)
		// would strand progress at 'restarting'; surface it so the modal resolves.
		defer func() {
			if rec := recover(); rec != nil {
				progress.fail(fmt.Errorf("update restart panicked: %v", rec))
			}
		}()
		time.Sleep(750 * time.Millisecond)
		restart()
	}()
	return nil
}

// shutdownServer gracefully stops the running HTTP server so the successor can
// bind the port. main() sets it to the *http.Server's Shutdown; it is nil in
// CLI (`bloxsmith update`) mode, where no server is running.
var shutdownServer func(context.Context) error

// restart re-execs the (now updated) binary and exits the current process. A
// spawn+exit (rather than syscall.Exec) keeps the code identical on Windows,
// where exec-in-place is unavailable.
func restart() {
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	if handleRestart(exe) {
		os.Exit(0)
	}
}

// handleRestart launches the successor and, ONLY on a successful launch, releases
// the listen socket. It returns true when the caller should exit. If the child
// fails to start it reports phase=error and returns false WITHOUT releasing the
// socket, so the old binary keeps serving and the service stays up (fixes the
// EADDRINUSE race where the parent exited before the child could bind).
func handleRestart(exe string) bool {
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		progress.fail(fmt.Errorf("restart: could not launch new binary, keeping the old one: %w", err))
		return false
	}
	progress.set("done", 100)
	// Release the port so the successor (which retries the bind with a short
	// backoff in listenWithRetry) can take it over.
	if shutdownServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = shutdownServer(ctx)
		cancel()
	}
	return true
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
		// A panic here (extract/swap/nil-deref) would otherwise kill the goroutine
		// WITHOUT a terminal status, freezing progress at its last phase and leaving
		// the frontend polling forever. Recover into phase=error so the modal resolves.
		defer func() {
			if rec := recover(); rec != nil {
				progress.fail(fmt.Errorf("update panicked: %v", rec))
			}
		}()
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
	// Print each phase transition live by polling the shared progress struct that
	// applyLatest advances (checking->downloading->...->done). The goroutine stops
	// on done/error or when applyLatest returns and closes the done channel.
	done := make(chan struct{})
	go func() {
		last := ""
		for {
			select {
			case <-done:
				return
			case <-time.After(300 * time.Millisecond):
				snap := progress.snapshot()
				phase, _ := snap["phase"].(string)
				pct, _ := snap["pct"].(int)
				if phase != last {
					last = phase
					if phase == "checking" {
						fmt.Printf(">> %s...\n", phase)
					} else {
						fmt.Printf(">> %s  %d%%\n", phase, pct)
					}
				}
				if phase == "done" || phase == "error" {
					return
				}
			}
		}
	}()
	if err := applyLatest(); err != nil {
		close(done)
		fmt.Fprintln(os.Stderr, "update failed (old binary kept):", err)
		return 1
	}
	close(done)
	fmt.Println("updated to", st.Latest, "— restarting")
	return 0
}

// verifyReleaseSignature checks the Ed25519 signature over checksums.txt against
// the public key compiled into this binary (signing.go).
//
// Every failure here aborts the update. There is no "warn and continue" branch
// on purpose: the only reason to run this check is to refuse when it fails, and
// a check whose failure is survivable is a check an attacker simply causes to
// fail.
func verifyReleaseSignature(checksums, signature []byte) error {
	pub, err := hex.DecodeString(strings.TrimSpace(activeSigningKey))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		// A malformed compiled-in key is a build defect, not an attack — but it
		// must still stop the update rather than wave it through.
		return fmt.Errorf("this build has no usable release signing key, so the download cannot be authenticated")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil {
		return fmt.Errorf("release signature is not valid base64: %w", err)
	}
	if len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("release signature is %d bytes, want %d", len(sig), ed25519.SignatureSize)
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), checksums, sig) {
		return fmt.Errorf("RELEASE SIGNATURE DOES NOT VERIFY — checksums.txt was not signed by this project's release key; refusing to update")
	}
	return nil
}
