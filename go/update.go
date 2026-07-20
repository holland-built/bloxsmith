package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// appRepo is the GitHub repo the self-updater checks. Mirrors APP_REPO in
// server.py.
const appRepo = "holland-built/bloxsmith"

// verN maps a "major.minor.patch" / "vMAJOR.MINOR.PATCH" version to a single
// comparable integer for full-semver ranking, or -1 when unparseable.
// v2.0.0 > 1.9.0 > v1.0.595. Wide bases (1e6 per level) so the old
// 1.0.<commit-count> scheme's large patch numbers can't carry into minor.
// (The old port of _ver_n compared only the patch digit, so a 2.0.0 release
// ranked equal to any x.y.0 and self-update could never detect it.)
func verN(v string) int {
	m := regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`).FindStringSubmatch(v)
	if m == nil {
		return -1
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])
	return major*1_000_000_000_000 + minor*1_000_000 + patch
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
