package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/minio/selfupdate"
)

// appRepo is the GitHub repo the self-updater checks. Mirrors APP_REPO in
// server.py.
const appRepo = "holland-built/bloxsmith"

// verN extracts the integer <n> from a "1.0.<n>" / "v1.0.<n>" version, or -1.
// Port of _ver_n (server.py:82).
func verN(v string) int {
	m := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(v)
	if m == nil {
		return -1
	}
	n, _ := strconv.Atoi(m[3])
	return n
}

type updateStatus struct {
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	Available  bool   `json:"available"`
	URL        string `json:"url"`
	SelfUpdate bool   `json:"selfUpdate"`
}

// checkUpdate hits the GitHub Releases API for the latest tag. Same JSON shape
// as update_status (server.py:123). Really reaches GitHub — no stub.
func checkUpdate() (updateStatus, error) {
	st := updateStatus{Current: version, SelfUpdate: true}
	req, _ := http.NewRequest("GET",
		fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", appRepo), nil)
	req.Header.Set("User-Agent", "bloxsmith")
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return st, err
	}
	defer resp.Body.Close()
	var rel struct {
		Tag     string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return st, err
	}
	st.Latest, st.URL = rel.Tag, rel.HTMLURL
	st.Available = verN(rel.Tag) > verN(version) && verN(rel.Tag) >= 0
	return st, nil
}

// applyUpdate downloads a release binary URL and swaps the running executable.
// Compiled and wired; Phase 0 leaves the real download URL discovery to Phase 3
// (goreleaser asset naming), so the CLI path is guarded behind an explicit URL.
func applyUpdate(binURL string) error {
	resp, err := http.Get(binURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return selfupdate.Apply(io.Reader(resp.Body), selfupdate.Options{})
}
