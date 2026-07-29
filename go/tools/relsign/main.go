// Command relsign signs and verifies release artifacts with Ed25519.
//
// WHY THIS EXISTS. checksums.txt is fetched from the same GitHub release as the
// archive it validates. TLS, host pinning, the downgrade guard and the size caps
// are all fine, but an attacker who can replace the tarball in a release can
// replace the checksums beside it, so the checksum proves the download is intact
// — not that this project published it. The release already carries a cosign
// keyless signature, and README.md documents how to check it by hand, but no
// automated path ever did: scripts/install.sh said so plainly, and go/apply.go
// did not say it at all while silently relying on it.
//
// Ed25519 with a key held in GitHub Actions secrets closes that for the
// automated path. The public half is compiled into the binary (go/signing.go),
// so the trust anchor does NOT live in the release it validates — which is the
// entire point, and the one thing checksums.txt could never do.
//
// This does not replace the cosign signature; it sits alongside it. Cosign
// proves which workflow run produced the artifacts and is verifiable by a third
// party with no prior knowledge of this project. Ed25519 is what a shipped
// binary can check offline in a few lines of standard library.
//
//	relsign keygen                                  # print a fresh keypair
//	relsign sign   -key <hex|@file> -in F -out F.ed25519
//	relsign verify -pub <hex>       -in F -sig F.ed25519
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "keygen":
		keygen()
	case "sign":
		sign(os.Args[2:])
	case "verify":
		verify(os.Args[2:])
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: relsign keygen | sign -key K -in F -out F.sig | verify -pub K -in F -sig F.sig")
	os.Exit(2)
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "relsign: "+format+"\n", a...)
	os.Exit(1)
}

func keygen() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		die("generate: %v", err)
	}
	// The private value printed here is the 64-byte expanded form ed25519.Sign
	// takes directly, so the CI secret needs no derivation step.
	fmt.Printf("public  %s\n", hex.EncodeToString(pub))
	fmt.Printf("private %s\n", hex.EncodeToString(priv))
}

// readKey accepts a hex key inline or, with a leading @, from a file — so CI
// never has to put the secret on a command line where it could land in a log.
func readKey(s string) []byte {
	if strings.HasPrefix(s, "@") {
		b, err := os.ReadFile(s[1:])
		if err != nil {
			die("read key file: %v", err)
		}
		s = string(b)
	}
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		die("key is not hex: %v", err)
	}
	return b
}

func sign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	key := fs.String("key", "", "private key, hex or @file")
	in := fs.String("in", "", "file to sign")
	out := fs.String("out", "", "signature file to write (base64)")
	fs.Parse(args)
	if *key == "" || *in == "" || *out == "" {
		usage()
	}
	priv := readKey(*key)
	if len(priv) != ed25519.PrivateKeySize {
		die("private key is %d bytes, want %d", len(priv), ed25519.PrivateKeySize)
	}
	body, err := os.ReadFile(*in)
	if err != nil {
		die("read %s: %v", *in, err)
	}
	sig := ed25519.Sign(ed25519.PrivateKey(priv), body)
	if err := os.WriteFile(*out, []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
		die("write %s: %v", *out, err)
	}
	fmt.Printf("signed %s -> %s (%d bytes)\n", *in, *out, len(body))
}

func verify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	pub := fs.String("pub", "", "public key, hex or @file")
	in := fs.String("in", "", "file that was signed")
	sig := fs.String("sig", "", "signature file (base64)")
	fs.Parse(args)
	if *pub == "" || *in == "" || *sig == "" {
		usage()
	}
	pk := readKey(*pub)
	if len(pk) != ed25519.PublicKeySize {
		die("public key is %d bytes, want %d", len(pk), ed25519.PublicKeySize)
	}
	body, err := os.ReadFile(*in)
	if err != nil {
		die("read %s: %v", *in, err)
	}
	raw, err := os.ReadFile(*sig)
	if err != nil {
		die("read %s: %v", *sig, err)
	}
	s, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		die("signature is not base64: %v", err)
	}
	if !ed25519.Verify(ed25519.PublicKey(pk), body, s) {
		die("SIGNATURE DOES NOT VERIFY for %s", *in)
	}
	fmt.Printf("ok: %s verifies against the given public key\n", *in)
}
