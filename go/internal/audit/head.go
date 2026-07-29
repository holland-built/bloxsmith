package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// headRecord is the sealed pointer to the end of the chain, stored in the trust
// directory rather than beside the log.
//
// The old design had no equivalent, and that is exactly why truncation was
// undetectable: Verify walked forward from a zero hash with nothing telling it
// how far the chain was supposed to go, so any prefix of a valid chain was
// itself a valid chain. Count closes that hole, and MAC is what stops an
// attacker simply rewriting Count.
//
// KeyID lets a rotated or lost key be told apart from tampering — see Key.
type headRecord struct {
	Count int    `json:"count"`
	Hash  string `json:"hash"` // hash of entry Count-1; "" when Count == 0
	KeyID string `json:"key_id"`
	MAC   string `json:"mac"`
}

// headFile is the sealed head's path, always inside the trust directory.
//
// The name is qualified by a digest of the log's absolute path because one
// trust directory routinely serves more than one log on the same machine: this
// repo runs a dev copy on :8090 beside the installed one on :8080, each with its
// own state directory, and both resolve to the same per-user config directory.
// A single shared "audit.head" would have each instance overwrite the other's
// seal, and the loser would then report its own untouched chain as tampered —
// a fabricated accusation produced entirely by the design of the file name.
func (l *Log) headFile() string {
	p := l.path
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	sum := sha256.Sum256([]byte(p))
	return filepath.Join(l.trustDir, headFileName+"-"+hex.EncodeToString(sum[:6]))
}

// readHead returns (nil, nil) when the chain has never been sealed — a real
// state (a log written before this version, or a wiped trust directory), told
// apart from an unreadable head, which is an error. Verify must never treat
// either as "intact".
func (l *Log) readHead() (*headRecord, error) {
	if l.trustDir == "" {
		return nil, nil
	}
	b, err := os.ReadFile(l.headFile())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var h headRecord
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, fmt.Errorf("sealed head record is not valid JSON: %w", err)
	}
	if h.Count < 0 {
		return nil, fmt.Errorf("sealed head record has a negative count (%d)", h.Count)
	}
	return &h, nil
}

// writeHead seals count entries ending at hash. It writes to a temp file in the
// same directory and renames, so a crash mid-write leaves the previous seal
// intact rather than a half-written one that would read as tampering.
func (l *Log) writeHead(count int, hash string) error {
	if l.key == nil {
		return fmt.Errorf("audit: cannot seal the chain without a key: %w", l.keyErr)
	}
	if l.trustDir == "" {
		return fmt.Errorf("audit: cannot seal the chain without a trust directory")
	}
	h := headRecord{
		Count: count,
		Hash:  hash,
		KeyID: l.key.id,
		MAC:   headMAC(l.key.secret, count, hash),
	}
	b, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(l.trustDir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(l.trustDir, filepath.Base(l.headFile())+".*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name) // no-op once the rename has succeeded
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, l.headFile())
}
