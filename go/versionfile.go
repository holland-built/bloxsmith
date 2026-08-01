package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// THE STATIC VERSION FILE: A FREE ANSWER TO "IS THERE A NEWER RELEASE?"
//
// WHY THIS EXISTS
// GitHub's REST API allows 60 unauthenticated requests per hour, counted per
// SOURCE IP — one shared bucket for every operator behind a single corporate
// connection. /api/update/check used to spend one of those on every dashboard
// page load. Downloading a RELEASE ASSET is not a REST API call: it is a plain
// file download, and it is not subject to that limit. So every release now
// attaches a ~30-byte version.json (go/.goreleaser.yaml: a before-hook writes
// it, release.extra_files uploads it), reachable at the fixed URL
//
//	https://github.com/<repo>/releases/latest/download/version.json
//
// which GitHub always resolves to the newest release. Reading it costs nothing
// against the allowance, so a fleet of any size can check freely.
//
// THIS FILE IS NOT A TRUST ANCHOR. IT IS UNSIGNED.
// It is not covered by checksums.txt and carries no cosign or ssh signature —
// the release signing pipeline signs the artifacts you INSTALL, and this is not
// one of them. All it is allowed to do is tell the client that a version with
// some tag EXISTS, so the UI can offer an Update button. Everything about
// actually installing that version is unchanged and still goes through
// apply.go: a fresh GitHub API lookup, the checksums file, and signature
// verification. If you are reading this because you want the version file to
// carry a download URL, a checksum, a "please upgrade now" flag, or anything
// else the client would ACT on — do not. An unsigned file on a CDN must never
// become an instruction to download and execute something. Sign it first, or
// put it somewhere that is already signed.
//
// That is also why staticVersion below reads exactly one field out of the file
// and derives the release-page link itself (see releasePageURL): the fewer
// things this file gets to decide, the less an attacker who can serve a fake
// one can do.

// githubDownloadBase is the host the static version file is fetched from. This
// is github.com, NOT api.github.com — the whole point is to stay off the API.
// A var (not a const) so tests can point it at an httptest.Server, the same
// seam discipline githubAPIBase uses in update.go.
var githubDownloadBase = "https://github.com"

// versionFileAsset is the release asset name. It must match the extra_files
// glob in go/.goreleaser.yaml; changing one without the other silently turns
// every check back into an API call.
const versionFileAsset = "version.json"

// maxVersionFileBytes bounds the read. The published file is under 40 bytes;
// anything near this cap is not the file we published (a proxy interstitial, a
// captive-portal login page, an error document), and slurping an arbitrary
// remote body on every page load is not something to do unbounded.
const maxVersionFileBytes = 4 << 10

// versionFile is the on-disk/on-wire shape. ONE field on purpose.
//
// Format decision — JSON rather than a bare version string: this file is read
// by clients we can never upgrade, because an operator running an old build is
// exactly who needs to be told a new one exists. encoding/json ignores fields
// it does not know, so a future release can add a key and every binary already
// in the field keeps parsing the file unchanged. A bare string has no room to
// grow without a format break those same clients cannot survive. The strict
// parse is a second, smaller win: an HTML error page served with a 200 fails
// loudly here instead of being read as a version.
type versionFile struct {
	// Tag is the release tag, e.g. "v3.14.0" — the same string the GitHub API
	// returns as tag_name, so verN ranks the two identically.
	Tag string `json:"tag"`
}

// releasePageURL builds the human release page link for a tag. Derived, not
// read from the version file: the file is unsigned, and a link the operator
// clicks is exactly the kind of thing a forged copy should not get to choose.
// The shape is GitHub's fixed release-page URL and is byte-identical to the
// html_url the API returns for the same tag, so the UI behaves the same on
// either path. (apply.go's archiveAssetName already derives asset names from a
// fixed scheme the same way.)
func releasePageURL(tag string) string {
	return fmt.Sprintf("%s/%s/releases/tag/%s", githubDownloadBase, appRepo, tag)
}

// staticVersion reads the latest release tag from the static version file.
//
// EVERY failure mode returns an error and an empty tag: a transport error, a
// non-200 (every release published before this feature has no version.json and
// answers 404), an oversized or unparseable body, or a body whose tag is
// missing or unrankable. There is deliberately no zero-value "nothing found"
// result, because "the file could not be read" and "there is no newer version"
// are different facts and a caller must not be able to confuse them. The only
// correct response to an error here is to go and ask something else — which is
// what fetchUpdate does, falling back to the GitHub API.
func staticVersion() (tag string, err error) {
	url := fmt.Sprintf("%s/%s/releases/latest/download/%s",
		githubDownloadBase, appRepo, versionFileAsset)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "bloxsmith")
	req.Header.Set("Accept", "application/json")
	// Same 10s budget as the API call this replaces; GitHub redirects the
	// download to its asset CDN and the default client follows that.
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("%s: %w", versionFileAsset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", versionFileAsset, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxVersionFileBytes+1))
	if err != nil {
		return "", fmt.Errorf("%s: %w", versionFileAsset, err)
	}
	if len(body) > maxVersionFileBytes {
		return "", fmt.Errorf("%s: body is larger than %d bytes, which is not the file we publish",
			versionFileAsset, maxVersionFileBytes)
	}
	var vf versionFile
	if err := json.Unmarshal(body, &vf); err != nil {
		return "", fmt.Errorf("%s: %w", versionFileAsset, err)
	}
	if vf.Tag == "" || verN(vf.Tag) < 0 {
		return "", fmt.Errorf("%s had no usable tag (got %q)", versionFileAsset, vf.Tag)
	}
	return vf.Tag, nil
}
