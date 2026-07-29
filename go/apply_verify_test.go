package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// This file proves fetchVerifiedBinary — the download -> verify signature ->
// verify checksum -> extract seam pulled out of applyLatest — actually works,
// and that each of its refusals fires for its OWN reason. It never calls
// selfupdate.Apply or restart(): fetchVerifiedBinary stops before either.

const testArchName = "test-release.tar.gz"

// buildArchive returns a tar.gz containing a single file named "bloxsmith"
// with the given contents.
func buildArchive(t *testing.T, binContents []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "bloxsmith", Mode: 0o755, Size: int64(len(binContents))}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(binContents); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// buildArchiveNoBinary returns a tar.gz with a file that is NOT "bloxsmith".
func buildArchiveNoBinary(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	contents := []byte("not the binary")
	if err := tw.WriteHeader(&tar.Header{Name: "README.txt", Mode: 0o644, Size: int64(len(contents))}); err != nil {
		t.Fatalf("tar header: %v", err)
	}
	if _, err := tw.Write(contents); err != nil {
		t.Fatalf("tar write: %v", err)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func checksumsFor(archive []byte) []byte {
	sum := sha256.Sum256(archive)
	return []byte(fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), testArchName))
}

// testServer serves the archive/checksums/signature (any of which may be nil
// to simulate absence) at fixed paths and returns their URLs plus the server
// for cleanup.
type testServerAssets struct {
	archive []byte
	sums    []byte
	sig     []byte // nil means "asset absent from the release"
}

func startTestServer(t *testing.T, a testServerAssets) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/archive", func(w http.ResponseWriter, r *http.Request) {
		w.Write(a.archive)
	})
	mux.HandleFunc("/sums", func(w http.ResponseWriter, r *http.Request) {
		w.Write(a.sums)
	})
	mux.HandleFunc("/sig", func(w http.ResponseWriter, r *http.Request) {
		w.Write(a.sig)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// swapSigningKey points verification at a throwaway keypair, mirroring
// swapKey in signing_test.go, and returns the matching public/private pair.
func swapSigningKey(t *testing.T) (pub ed25519.PublicKey, priv ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	prev := activeSigningKey
	activeSigningKey = hex.EncodeToString(pub)
	t.Cleanup(func() { activeSigningKey = prev })
	return pub, priv
}

func sign(priv ed25519.PrivateKey, sums []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums)))
}

func TestFetchVerifiedBinary_HappyPath(t *testing.T) {
	_, priv := swapSigningKey(t)
	want := []byte("fake bloxsmith binary bytes v1")
	archive := buildArchive(t, want)
	sums := checksumsFor(archive)
	sig := sign(priv, sums)

	srv := startTestServer(t, testServerAssets{archive: archive, sums: sums, sig: sig})

	bin, gotArchive, err := fetchVerifiedBinary(srv.URL+"/archive", srv.URL+"/sums", srv.URL+"/sig", testArchName)
	if err != nil {
		t.Fatalf("expected success, got error: %v", err)
	}
	if !bytes.Equal(bin, want) {
		t.Fatalf("extracted binary bytes = %q, want %q", bin, want)
	}
	if !bytes.Equal(gotArchive, archive) {
		t.Fatal("returned archive bytes do not match what was served")
	}
}

func TestFetchVerifiedBinary_WrongSigningKeyRefused(t *testing.T) {
	swapSigningKey(t) // sets activeSigningKey to a key we will NOT sign with
	_, otherPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	archive := buildArchive(t, []byte("binary"))
	sums := checksumsFor(archive)
	sig := sign(otherPriv, sums) // signed by a DIFFERENT key than activeSigningKey

	srv := startTestServer(t, testServerAssets{archive: archive, sums: sums, sig: sig})

	_, _, err = fetchVerifiedBinary(srv.URL+"/archive", srv.URL+"/sums", srv.URL+"/sig", testArchName)
	if err == nil {
		t.Fatal("a signature made with a different key was accepted")
	}
	if !strings.Contains(err.Error(), "DOES NOT VERIFY") {
		t.Fatalf("error = %v, want it to name the signature failure", err)
	}
}

func TestFetchVerifiedBinary_EditedChecksumsRefusedOnSignature(t *testing.T) {
	_, priv := swapSigningKey(t)
	archive := buildArchive(t, []byte("binary"))
	sums := checksumsFor(archive)
	sig := sign(priv, sums) // signs the ORIGINAL sums

	edited := append([]byte{}, sums...)
	edited = bytes.Replace(edited, []byte("0"), []byte("1"), 1) // tamper after signing
	if bytes.Equal(edited, sums) {
		t.Fatal("test setup: tampering did not change checksums.txt")
	}

	srv := startTestServer(t, testServerAssets{archive: archive, sums: edited, sig: sig})

	_, _, err := fetchVerifiedBinary(srv.URL+"/archive", srv.URL+"/sums", srv.URL+"/sig", testArchName)
	if err == nil {
		t.Fatal("checksums.txt edited after signing was accepted")
	}
	// Must be refused on the SIGNATURE, not the checksum — the signature is
	// checked first for exactly this reason (see the comment in apply.go).
	if !strings.Contains(err.Error(), "DOES NOT VERIFY") {
		t.Fatalf("error = %v, want a signature failure (checked before checksum), not a checksum mismatch", err)
	}
}

func TestFetchVerifiedBinary_AlteredArchiveRefusedOnChecksum(t *testing.T) {
	_, priv := swapSigningKey(t)
	archive := buildArchive(t, []byte("original binary"))
	tampered := buildArchive(t, []byte("tampered binary!!"))

	// checksums.txt matches the ORIGINAL archive, then is re-signed — so the
	// signature over checksums.txt is perfectly valid, and the only thing
	// wrong is that the served archive no longer matches its own checksum.
	// This is what proves the two checks are independent.
	sums := checksumsFor(archive)
	sig := sign(priv, sums)

	srv := startTestServer(t, testServerAssets{archive: tampered, sums: sums, sig: sig})

	_, _, err := fetchVerifiedBinary(srv.URL+"/archive", srv.URL+"/sums", srv.URL+"/sig", testArchName)
	if err == nil {
		t.Fatal("an archive that doesn't match checksums.txt was accepted")
	}
	if strings.Contains(err.Error(), "DOES NOT VERIFY") {
		t.Fatalf("error = %v, want a checksum failure — the signature should have passed", err)
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("error = %v, want it to name the checksum mismatch", err)
	}
}

// TestApplyLatest_MissingSignatureAssetRefused covers the "signature asset
// absent from the release" case at the level it actually happens: applyLatest
// checks assetURL(rel, releaseSigAssetName) == "" and refuses BEFORE ever
// calling fetchVerifiedBinary (see apply.go). That means this path never
// downloads anything and never reaches selfupdate.Apply, so it is safe to
// call applyLatest() directly here.
func TestApplyLatest_MissingSignatureAssetRefused(t *testing.T) {
	swapSigningKey(t)

	archive := buildArchive(t, []byte("binary"))
	archName := archiveAssetName("v9.9.9")

	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/repos/%s/releases/latest", appRepo), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v9.9.9",
			"assets": []map[string]string{
				{"name": archName, "browser_download_url": "PLACEHOLDER_ARCH"},
				{"name": "checksums.txt", "browser_download_url": "PLACEHOLDER_SUMS"},
				// releaseSigAssetName deliberately omitted.
			},
		})
	})
	mux.HandleFunc("/archive", func(w http.ResponseWriter, r *http.Request) { w.Write(archive) })
	mux.HandleFunc("/sums", func(w http.ResponseWriter, r *http.Request) { w.Write(checksumsFor(archive)) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prevBase, prevVersion := githubAPIBase, version
	githubAPIBase = srv.URL
	version = "1.0.0" // older than v9.9.9 so the downgrade guard doesn't fire first
	t.Cleanup(func() { githubAPIBase = prevBase; version = prevVersion })

	err := applyLatest()
	if err == nil {
		t.Fatal("a release with no signature asset was accepted")
	}
	if !strings.Contains(err.Error(), "not signed") {
		t.Fatalf("error = %v, want it to say the release is not signed", err)
	}
}

func TestFetchVerifiedBinary_NoBinaryInArchiveRefused(t *testing.T) {
	_, priv := swapSigningKey(t)
	archive := buildArchiveNoBinary(t)
	sums := checksumsFor(archive)
	sig := sign(priv, sums)

	srv := startTestServer(t, testServerAssets{archive: archive, sums: sums, sig: sig})

	_, _, err := fetchVerifiedBinary(srv.URL+"/archive", srv.URL+"/sums", srv.URL+"/sig", testArchName)
	if err == nil {
		t.Fatal("an archive with no bloxsmith binary was accepted")
	}
	if !strings.Contains(err.Error(), "not found in archive") {
		t.Fatalf("error = %v, want it to say bloxsmith was not found", err)
	}
}

// TestLatestRelease_UsesGithubAPIBase proves latestRelease() now resolves
// through the same seam checkUpdate uses, so it is reachable by a test
// (and, in production, by anything that repoints githubAPIBase).
func TestLatestRelease_UsesGithubAPIBase(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc(fmt.Sprintf("/repos/%s/releases/latest", appRepo), func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.9.9"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prev := githubAPIBase
	githubAPIBase = srv.URL
	t.Cleanup(func() { githubAPIBase = prev })

	rel, err := latestRelease()
	if err != nil {
		t.Fatalf("latestRelease() did not reach the stub server through githubAPIBase: %v", err)
	}
	if rel.Tag != "v9.9.9" {
		t.Fatalf("Tag = %q, want v9.9.9 (from the stub, proving the seam is used)", rel.Tag)
	}
}
