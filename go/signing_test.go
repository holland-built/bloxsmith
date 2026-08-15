package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The defect: checksums.txt was fetched from the same release as the archive it
// validated, so an attacker who could replace one could replace the other and
// the update applied cleanly. The compiled-in public key is the anchor that does
// not travel with the release.

func TestReleaseSigningKeyIsUsable(t *testing.T) {
	pub, err := hex.DecodeString(strings.TrimSpace(releaseSigningKey))
	if err != nil {
		t.Fatalf("the compiled-in release signing key is not hex: %v", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Fatalf("the compiled-in release signing key is %d bytes, want %d — every self-update would refuse",
			len(pub), ed25519.PublicKeySize)
	}
}

func TestVerifyReleaseSignature_AcceptsAGenuineSignature(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	restore := swapKey(t, hex.EncodeToString(pub))
	defer restore()

	sums := []byte("abc123  bloxsmith_9.9.9_macOS_universal.tar.gz\n")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums))
	if err := verifyReleaseSignature(sums, []byte(sig+"\n")); err != nil {
		t.Fatalf("a genuine signature was rejected: %v", err)
	}
}

// TestVerifyReleaseSignature_RejectsTheActualAttack is the point of the whole
// change: the attacker swaps BOTH the archive and checksums.txt, and signs with
// a key of their own. Under the old code the update applied without complaint.
func TestVerifyReleaseSignature_RejectsTheActualAttack(t *testing.T) {
	realPub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, attackerPriv, _ := ed25519.GenerateKey(rand.Reader)
	restore := swapKey(t, hex.EncodeToString(realPub))
	defer restore()

	forged := []byte("deadbeef  bloxsmith_9.9.9_macOS_universal.tar.gz\n")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(attackerPriv, forged))

	err := verifyReleaseSignature(forged, []byte(sig))
	if err == nil {
		t.Fatal("a checksums.txt signed by someone else's key was accepted — the update path is still unanchored")
	}
	if !strings.Contains(err.Error(), "DOES NOT VERIFY") {
		t.Fatalf("the refusal does not say what happened: %v", err)
	}
}

func TestVerifyReleaseSignature_RejectsEditedChecksums(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	restore := swapKey(t, hex.EncodeToString(pub))
	defer restore()

	sums := []byte("abc123  bloxsmith_9.9.9_macOS_universal.tar.gz\n")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, sums))
	edited := []byte("abc124  bloxsmith_9.9.9_macOS_universal.tar.gz\n")

	if err := verifyReleaseSignature(edited, []byte(sig)); err == nil {
		t.Fatal("an edited checksums.txt still verified")
	}
}

// TestVerifyReleaseSignature_RejectsGarbage covers the shapes an attacker gets
// for free: an empty file, truncation, and a signature of the wrong length.
// None may be survivable — a check whose failure can be shrugged off is one an
// attacker just causes to fail.
func TestVerifyReleaseSignature_RejectsGarbage(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	restore := swapKey(t, hex.EncodeToString(pub))
	defer restore()
	sums := []byte("abc123  x.tar.gz\n")
	good := ed25519.Sign(priv, sums)

	cases := map[string][]byte{
		"empty":         {},
		"not base64":    []byte("!!!!not base64!!!!"),
		"short":         []byte(base64.StdEncoding.EncodeToString(good[:32])),
		"long":          []byte(base64.StdEncoding.EncodeToString(append(good, good...))),
		"whitespace":    []byte("   \n\t "),
		"base64 of nil": []byte(base64.StdEncoding.EncodeToString(nil)),
	}
	for name, sig := range cases {
		if err := verifyReleaseSignature(sums, sig); err == nil {
			t.Fatalf("%s signature was accepted", name)
		}
	}
}

func TestVerifyReleaseSignature_RefusesWhenTheBuildHasNoKey(t *testing.T) {
	restore := swapKey(t, "not-a-key")
	defer restore()
	if err := verifyReleaseSignature([]byte("x"), []byte("y")); err == nil {
		t.Fatal("a build with an unusable signing key still allowed an update through")
	}
}

// swapKey temporarily points verification at a throwaway key.
func swapKey(t *testing.T, hexKey string) func() {
	t.Helper()
	prev := activeSigningKey
	activeSigningKey = hexKey
	return func() { activeSigningKey = prev }
}

// THE THIRD PINNING, which release.yml does not look at.
//
// The release key is written down in three places. release.yml re-verifies the
// signature it just made against two of them — go/signing.go for the raw Ed25519
// form (release.yml:169-172) and scripts/install.sh's SIG_SSH_PUBKEY for the SSH
// form (release.yml:203-208). It never reads SIG_PUBKEY_PEM.
//
// That constant is what install.sh's OpenSSL fallback trusts, on hosts with no
// usable ssh-keygen. Rotate the signing key, update signing.go, and forget the
// PEM, and the release still builds, signs, verifies and publishes — while every
// install on that path fails with "RELEASE SIGNATURE DOES NOT VERIFY — refusing
// to install", which reads as an attack rather than a typo. A false alarm in a
// security control is worse than a missing one: it teaches people to route around
// the check.
//
// This lives in a Go test rather than in release.yml on purpose. `go test -race
// ./...` runs on every push (ci.yml:201), so drift is caught before a tag exists;
// the two checks release.yml already does only run once someone is cutting a
// release.
func TestInstallShPEMKeyMatchesTheCompiledInKey(t *testing.T) {
	const path = "../scripts/install.sh"
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v — this test exists to compare against it, so a missing file is a failure, not a skip", path, err)
	}

	m := regexp.MustCompile(`(?s)SIG_PUBKEY_PEM="-----BEGIN PUBLIC KEY-----\n(.*?)\n-----END PUBLIC KEY-----"`).FindSubmatch(src)
	if m == nil {
		t.Fatalf("no SIG_PUBKEY_PEM block found in %s. If it was renamed or removed, this test must be updated in the same change — do not delete it, because nothing else checks that key", path)
	}

	der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(m[1])), ""))
	if err != nil {
		t.Fatalf("SIG_PUBKEY_PEM in %s is not valid base64: %v", path, err)
	}
	// Ed25519 SubjectPublicKeyInfo is a 12-byte prefix then the 32-byte key.
	if len(der) != 12+ed25519.PublicKeySize {
		t.Fatalf("SIG_PUBKEY_PEM decodes to %d bytes, want %d — that is not an Ed25519 public key",
			len(der), 12+ed25519.PublicKeySize)
	}
	got := hex.EncodeToString(der[len(der)-ed25519.PublicKeySize:])

	want := strings.ToLower(strings.TrimSpace(releaseSigningKey))
	if got != want {
		t.Fatalf("the release key pinned in %s does not match the one compiled into this binary.\n"+
			"  install.sh SIG_PUBKEY_PEM : %s\n"+
			"  go/signing.go             : %s\n"+
			"Both must be the public half of RELEASE_SIGNING_KEY. Whichever was rotated,\n"+
			"the other has to move with it or install.sh's OpenSSL path will refuse every\n"+
			"genuine release with a message that reads like an attack.", path, got, want)
	}
}
