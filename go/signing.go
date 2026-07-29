package main

// Release signing trust anchor.
//
// THE GAP THIS CLOSES. applyLatest downloads an archive and checks it against
// checksums.txt fetched from the SAME GitHub release. TLS, host pinning, the
// downgrade guard and the size caps are all correct, but an attacker who can
// replace the tarball in a release can replace the checksums file sitting beside
// it. So the checksum proves the download arrived intact — never that this
// project published it. scripts/install.sh has said exactly that in a comment
// since it was written; apply.go said nothing at all while relying on the same
// unanchored checksum to swap the running binary.
//
// releaseSigningKey is the public half of an Ed25519 keypair whose private half
// lives only in this repository's GitHub Actions secrets (RELEASE_SIGNING_KEY).
// Because the public key is COMPILED IN, the thing that decides whether an
// update is genuine does not travel with the update. That is the property
// checksums.txt structurally cannot have, and it is the whole fix.
//
// HONEST SCOPE. This authenticates the release pipeline, not the source: anyone
// who can push a tag, or who steals the Actions secret, can still produce a
// signature that verifies. It stops an attacker who can write release assets
// (a compromised token with contents:write, a hijacked upload, a bad mirror)
// but not one who owns CI. Rotating the key means shipping a new binary, which
// is the cost of an anchor that does not live in the release.
//
// This sits alongside the cosign keyless signature the release also carries
// (checksums.txt.sig / .pem, verifiable by a third party per README.md). Cosign
// proves which workflow run built the artifacts; this is what a shipped binary
// can check offline with the standard library and no network round trip to a
// transparency log.
const releaseSigningKey = "2f43b683c88932f930ed9c48c35346b03f026fa5f61fe2db16cddefc66111b89"

// releaseSigAssetName is the release asset holding the base64 Ed25519 signature
// over checksums.txt.
const releaseSigAssetName = "checksums.txt.ed25519"

// activeSigningKey is what verifyReleaseSignature actually reads. It is a var
// seeded from the const rather than the const itself so tests can point
// verification at a throwaway keypair: the reject paths — a foreign key, an
// edited checksums.txt, a truncated signature — cannot be exercised any other
// way without shipping the real private key, and an unexercised refusal is a
// refusal nobody has checked works.
var activeSigningKey = releaseSigningKey
