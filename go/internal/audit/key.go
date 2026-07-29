package audit

// The trust root: the HMAC key and the sealed head record that together make
// the chain tamper-EVIDENT rather than merely corruption-evident.
//
// WHY THIS EXISTS. Until now the chain was a plain unkeyed SHA-256 over
// {ts, event, actor, detail, prev_hash}. The algorithm is public and takes no
// secret, so anyone who could write audit_log.jsonl could delete or edit an
// entry and recompute every following hash in about ten lines of Python, and
// Verify() still returned valid:true. Truncating the tail was undetectable by
// construction: Verify walked forward from a zero hash with no entry count and
// no head pointer, so the first 40 lines of a 412-entry chain verified
// perfectly. That detects accidental corruption, not an adversary — which is
// the whole point of the feature.
//
// Two mechanisms fix it, and both are needed:
//
//  1. Every appended entry carries an HMAC-SHA256 over its own hash, under a
//     key held by the writer and NOT stored in the log. Forging or editing an
//     entry now requires the key, not just the algorithm.
//  2. A sealed head record — {count, final hash} with its own MAC — is kept in
//     a trust directory OUTSIDE the log's directory. Cutting entries off the
//     end changes the count, and the count is authenticated, so a truncated
//     tail is detected instead of verifying clean.
//
// HONEST SCOPE, because overstating a security control is worse than not
// shipping one. The default install generates the key at
// <trust dir>/audit.key, mode 0600, on the same machine. That defeats an
// attacker who can write the log file but is not the operator: a path
// traversal bug, a stolen copy of the state directory, a shared or mounted
// volume, a different local account, a backup. It does NOT defeat a process
// already running as the operator — that process can read the key file and
// forge freely. For a trust root the machine itself does not hold, set
// AUDIT_KEY (or AUDIT_KEY_FILE) from an injected secret, and point
// AUDIT_TRUST_DIR at storage the log's writer cannot reach. This is the same
// limit README.md documents for VAULT_PASSPHRASE, and it is inherent to
// unattended operation, not a defect in this code.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// minKeySize is the shortest key accepted from an operator. HMAC-SHA256's
// security caps out at the 32-byte block-independent level, and anything
// materially shorter invites a passphrase being pasted in where a key belongs.
const minKeySize = 32

// keyFileName / headFileName live in the trust directory, never beside the log.
const (
	keyFileName  = "audit.key"
	headFileName = "audit.head"
)

// Domain separation strings: an entry MAC and a head MAC must never be
// interchangeable, or a head record could be replayed as an entry signature.
const (
	entryMACDomain = "bloxsmith/audit/entry/v1\n"
	headMACDomain  = "bloxsmith/audit/head/v1\n"
	keyIDDomain    = "bloxsmith/audit/keyid/v1\n"
)

// Key is the audit HMAC secret plus a non-secret identifier for it.
//
// id is what lets a rotated or lost key be told apart from tampering. An entry
// records the id of the key that signed it; if this process holds a different
// key, Verify reports could-not-verify ("signed with a key I do not have")
// rather than broken ("someone forged this"). Reporting a key change as
// tampering would be a fabricated accusation, which is the failure mode this
// whole change exists to remove.
type Key struct {
	secret []byte
	id     string
	source string
}

// ID is the short public identifier for this key (never the key itself).
func (k *Key) ID() string {
	if k == nil {
		return ""
	}
	return k.id
}

// Source describes where the key came from, for the startup log line. It names
// the env var or file path — never the key material.
func (k *Key) Source() string {
	if k == nil {
		return "none"
	}
	return k.source
}

func newKey(secret []byte, source string) *Key {
	h := sha256.New()
	h.Write([]byte(keyIDDomain))
	h.Write(secret)
	return &Key{secret: secret, id: hex.EncodeToString(h.Sum(nil)[:8]), source: source}
}

// Options carries the trust-root configuration. TrustDir is required; Key and
// KeyFile are the operator-supplied overrides, in that precedence.
type Options struct {
	TrustDir string // AUDIT_TRUST_DIR, defaulting to DefaultTrustDir()
	Key      string // AUDIT_KEY, hex
	KeyFile  string // AUDIT_KEY_FILE, path to a file holding the hex key
}

// DefaultTrustDir is a SIBLING of the app's own config directory, not that
// directory itself. The leaf name matters and was got wrong first time round:
// on macOS the state directory that holds vault.json, .env and audit_log.jsonl
// already IS ~/Library/Application Support/bloxsmith, so defaulting the trust
// root to the per-user config directory put the key in the same directory as
// the log it signs — no separation at all, on the most common install there is.
// "bloxsmith-audit" cannot collide with it on any supported platform.
//
// What the separation buys, concretely: a bug or backup scoped to the state
// directory, and a mounted volume (the Docker case — /vault is mounted, the
// container's home is not), no longer carry the key. What it does not buy is
// protection from the operator's own processes; see the file header.
//
// A container with no HOME has neither location, so the second fallback exists
// and the error case is real: the caller logs it and the chain is written
// unsigned rather than not written at all.
func DefaultTrustDir() (string, error) {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "bloxsmith-audit"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("audit: no per-user config or home directory for the trust root, "+
			"so there is nowhere to keep a key away from the log; set AUDIT_TRUST_DIR or AUDIT_KEY: %w", err)
	}
	return filepath.Join(home, ".bloxsmith-audit"), nil
}

// parseKeyHex decodes and range-checks an operator-supplied key. A key that is
// set but unusable is an error, never a silent fall-through to a generated one:
// an operator who configured AUDIT_KEY and got a machine-local key instead
// would believe their chain was anchored off-box when it was not.
func parseKeyHex(s, source string) (*Key, error) {
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, fmt.Errorf("audit: key from %s is not hex: %w", source, err)
	}
	if len(b) < minKeySize {
		return nil, fmt.Errorf("audit: key from %s is %d bytes; need at least %d (%d hex characters)",
			source, len(b), minKeySize, minKeySize*2)
	}
	return newKey(b, source), nil
}

// loadKey resolves the trust root: AUDIT_KEY, then AUDIT_KEY_FILE, then a
// machine-local key generated once at <TrustDir>/audit.key.
func loadKey(opt Options) (*Key, error) {
	if strings.TrimSpace(opt.Key) != "" {
		return parseKeyHex(opt.Key, "AUDIT_KEY")
	}
	if p := strings.TrimSpace(opt.KeyFile); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("audit: AUDIT_KEY_FILE %s could not be read: %w", p, err)
		}
		return parseKeyHex(string(b), "AUDIT_KEY_FILE "+p)
	}
	if strings.TrimSpace(opt.TrustDir) == "" {
		return nil, errors.New("audit: no trust directory configured and no AUDIT_KEY/AUDIT_KEY_FILE set")
	}
	p := filepath.Join(opt.TrustDir, keyFileName)
	b, err := os.ReadFile(p)
	if err == nil {
		return parseKeyHex(string(b), p)
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("audit: key file %s could not be read: %w", p, err)
	}
	return generateKey(opt.TrustDir, p)
}

// generateKey creates the machine-local key once, with O_EXCL so two processes
// racing at first start cannot end up holding different keys — the loser
// re-reads the winner's file rather than overwriting it.
func generateKey(dir, p string) (*Key, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("audit: trust directory %s could not be created: %w", dir, err)
	}
	secret := make([]byte, minKeySize)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("audit: could not generate a key: %w", err)
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			b, rerr := os.ReadFile(p)
			if rerr != nil {
				return nil, fmt.Errorf("audit: key file %s appeared but could not be read: %w", p, rerr)
			}
			return parseKeyHex(string(b), p)
		}
		return nil, fmt.Errorf("audit: key file %s could not be created: %w", p, err)
	}
	defer f.Close()
	if _, err := f.WriteString(hex.EncodeToString(secret) + "\n"); err != nil {
		return nil, fmt.Errorf("audit: key file %s could not be written: %w", p, err)
	}
	return newKey(secret, p), nil
}

// entryMAC authenticates one entry. The entry's own hash already commits to
// every field including seq and prev_hash, so signing (seq, hash) authenticates
// the whole entry and its position in the chain.
func entryMAC(secret []byte, seq int, hash string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(entryMACDomain))
	m.Write([]byte(strconv.Itoa(seq)))
	m.Write([]byte{0})
	m.Write([]byte(hash))
	return hex.EncodeToString(m.Sum(nil))
}

// headMAC authenticates the sealed end of the chain: how many entries there
// are, and what the last one hashes to. The count is what makes truncation
// detectable — it is the piece the old design had no equivalent of.
func headMAC(secret []byte, count int, hash string) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(headMACDomain))
	m.Write([]byte(strconv.Itoa(count)))
	m.Write([]byte{0})
	m.Write([]byte(hash))
	return hex.EncodeToString(m.Sum(nil))
}

// macEqual compares two hex MAC strings in constant time.
func macEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}
