// Package audit ports server.py's immutable SHA-256 hash-chained action log
// (server.py:2418-2459): _audit_entry_hash (2429), audit_read (2433),
// audit_append (2440), audit_verify_chain (2452). Each entry hashes its own
// payload plus the previous entry's hash, so any edit or deletion breaks the
// chain. The on-disk format (audit_log.jsonl, one JSON object per line) and the
// canonical hashing (see canonical.go) are byte-compatible with the Python app,
// so a chain written by either verifies under the other.
package audit

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const zeroHash = "0000000000000000000000000000000000000000000000000000000000000000"

// Log is the append-only audit store bound to one audit_log.jsonl path.
type Log struct {
	path        string
	imageDigest string // server.py:80 _IMAGE_DIGEST ("app-v"+APP_VERSION)
	instanceID  string // server.py:72 _INSTANCE_ID (per-process id)
	mu          sync.Mutex
	now         func() float64 // injectable for tests; wall clock in prod
}

// New binds a Log to path, pinning every appended entry to this image+instance
// (server.py:2445), exactly as audit_append does.
func New(path, imageDigest, instanceID string) *Log {
	return &Log{
		path:        path,
		imageDigest: imageDigest,
		instanceID:  instanceID,
		now:         func() float64 { return float64(time.Now().UnixNano()) / 1e9 },
	}
}

// Read ports audit_read (server.py:2433): every non-blank JSONL line as a map.
// Numbers are decoded as json.Number so the exact on-disk token is preserved
// (a Python-written float ts round-trips byte-for-byte into the canonical hash
// input). Missing file -> empty slice (never nil), matching Python's [].
func (l *Log) Read() []map[string]any {
	out := []map[string]any{}
	f, err := os.Open(l.path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(line))
		dec.UseNumber()
		var e map[string]any
		if dec.Decode(&e) == nil {
			out = append(out, e)
		}
	}
	return out
}

// entryHash ports _audit_entry_hash (server.py:2429): sha256 of the canonical
// JSON of every field except "hash".
func (l *Log) entryHash(e map[string]any) (string, error) {
	payload := make(map[string]any, len(e))
	for k, v := range e {
		if k != "hash" {
			payload[k] = v
		}
	}
	c, err := canonicalJSON(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(c)
	return hex.EncodeToString(sum[:]), nil
}

// Append ports audit_append (server.py:2440): read the chain, link to the last
// hash (or 64 zeros), inject image_digest+instance_id into detail, hash, and
// append one canonical JSON line. The file line is written with the SAME
// canonical encoder used for hashing so the ts token on disk matches the hashed
// token exactly. Returns the written entry.
func (l *Log) Append(event, actor string, detail map[string]any) (map[string]any, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	entries := l.Read()
	prev := zeroHash
	if n := len(entries); n > 0 {
		if h, ok := entries[n-1]["hash"].(string); ok {
			prev = h
		}
	}
	d := map[string]any{}
	for k, v := range detail {
		d[k] = v
	}
	d["image_digest"] = l.imageDigest
	d["instance_id"] = l.instanceID

	e := map[string]any{
		"ts":        json.Number(pyFloat(l.now())),
		"event":     event,
		"actor":     actor,
		"detail":    d,
		"prev_hash": prev,
	}
	h, err := l.entryHash(e)
	if err != nil {
		return nil, err
	}
	e["hash"] = h

	line, err := canonicalJSON(e)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return nil, err
	}
	return e, nil
}

// Verify ports audit_verify_chain (server.py:2452): walk the chain, checking
// each entry's prev_hash link and recomputed hash. Returns {"valid": bool,
// "broken_index": int|nil}, matching the JSON shape /api/audit/log ships.
func (l *Log) Verify() map[string]any {
	entries := l.Read()
	prev := zeroHash
	for i, e := range entries {
		ph, _ := e["prev_hash"].(string)
		want, _ := e["hash"].(string)
		got, err := l.entryHash(e)
		if err != nil || ph != prev || got != want {
			return map[string]any{"valid": false, "broken_index": i}
		}
		prev = want
	}
	return map[string]any{"valid": true, "broken_index": nil}
}
