// Package audit is the append-only, tamper-evident action log.
//
// Each entry hashes its own payload plus the previous entry's hash, and — since
// the keyed rewrite — also carries its position in the chain and an HMAC under
// a key held outside the log's directory, with a separately sealed record of how
// many entries the chain is supposed to have. Editing, deleting or truncating
// the file now requires the key rather than just the (public) algorithm. See
// key.go for the full rationale and the honest scope of what that key protects.
//
// PROVENANCE AND COMPATIBILITY. This started as a port of server.py's
// _audit_entry_hash (2429), audit_read (2433), audit_append (2440) and
// audit_verify_chain (2452); the on-disk format is still audit_log.jsonl, one
// JSON object per line, and the canonical hashing (canonical.go) is still
// byte-identical to Python's json.dumps(sort_keys=True). Entries written before
// the keyed rewrite therefore keep verifying unchanged — that mattered more
// than anything else here, since making an existing operator's real audit log
// suddenly read as "tampered" would be a fabricated accusation.
//
// What is NOT claimed any more: entries written by this binary carry seq,
// key_id and mac fields, and the Python verifier does not know to exclude mac
// from the hash payload, so it would call them tampered. Cross-verification
// under the original Python implementation is no longer offered. Nothing in
// this repository runs that implementation.
package audit

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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

	// mu is an RWMutex rather than a Mutex so that reading the chain excludes a
	// concurrent Append without verifiers excluding each other. Append and Adopt
	// take the write lock; Verify and AppendHealth take the read lock. What this
	// buys is that a verifier cannot observe a half-flushed final line and report
	// "audit log incomplete" about a log that is perfectly fine. What it does NOT
	// buy is anything across processes — see Verify.
	mu  sync.RWMutex
	now func() float64 // injectable for tests; wall clock in prod

	trustDir string // holds audit.key + audit.head; never the log's own directory
	key      *Key   // nil when no key could be established
	keyErr   error  // why, surfaced as could-not-verify — never as "intact"
	keyWarn  sync.Once

	// readOnly is set by OpenReadOnly. Every write path checks it, so a verifier
	// physically cannot append an entry or reseal the head — not "does not", but
	// "cannot". An offline check that could reseal would let the act of verifying
	// launder a truncated chain into a clean one.
	readOnly bool

	// appendFailures counts entries Append refused or failed to write, and
	// lastFailure names the most recent one. Both are guarded by mu.
	//
	// Every caller discards Append's error into a log line, so before this the
	// only trace of an unrecorded event was one Printf nobody reads. A count the
	// process can report turns "the audit log looks quiet" into a question the
	// operator can actually answer: quiet because nothing happened, or quiet
	// because n writes were refused. Exposed through AppendHealth.
	appendFailures int
	lastFailure    *appendFailure
}

// appendFailure is the record of one entry that never reached disk.
type appendFailure struct {
	event string
	actor string
	err   string
	ts    float64
}

// recordAppendFailure counts a failed append and remembers it, then hands the
// error straight back so call sites stay one line. The caller MUST already hold
// l.mu — every use is inside Append, which holds it for its whole body.
func (l *Log) recordAppendFailure(event, actor string, err error) error {
	l.appendFailures++
	l.lastFailure = &appendFailure{event: event, actor: actor, err: err.Error(), ts: l.now()}
	return err
}

// AppendHealth reports what the audit log could not record.
//
//	{"append_failures": 0}                            -> nothing has failed
//	{"append_failures": 2, "last_append_failure": {…}} -> 2 failed, here is the last
//
// last_append_failure is ABSENT when nothing has failed, rather than present
// with empty strings and a zero ts. A zero-value placeholder would make a
// healthy log and a log that dropped an entry at time zero render identically
// in any consumer that only checks whether the key exists.
func (l *Log) AppendHealth() map[string]any {
	l.mu.RLock()
	defer l.mu.RUnlock()
	h := map[string]any{"append_failures": l.appendFailures}
	if l.lastFailure != nil {
		h["last_append_failure"] = map[string]any{
			"event": l.lastFailure.event,
			"actor": l.lastFailure.actor,
			"error": l.lastFailure.err,
			"ts":    l.lastFailure.ts,
		}
	}
	return h
}

// OpenReadOnly binds a Log for verification ONLY, with two guarantees the normal
// constructor deliberately does not make:
//
//  1. It never creates a key. A missing key is an error the caller must report
//     as could-not-verify, not something to fix by generating one — a new key
//     cannot attest a chain signed with the old one, and pretending otherwise
//     would turn "I have no way to check this" into "this is fine".
//  2. Append and Adopt refuse. Verifying must not be able to change what it is
//     verifying, including by resealing a head that an attacker just shortened.
//
// It returns an error when the key cannot be established, so the caller decides
// what to say — rather than degrading silently the way New() must, since New()
// has to keep recording real events even with a broken trust root.
func OpenReadOnly(path string, opt Options) (*Log, error) {
	opt.NoGenerate = true
	l := &Log{
		path:     path,
		trustDir: strings.TrimSpace(opt.TrustDir),
		readOnly: true,
		now:      func() float64 { return 0 },
	}
	l.key, l.keyErr = loadKey(opt)
	if l.key == nil {
		return l, l.keyErr
	}
	return l, nil
}

// New binds a Log to path, pinning every appended entry to this image+instance
// (server.py:2445), and resolves the trust root described in key.go.
//
// A trust-root failure is deliberately NOT fatal. The alternative is refusing
// to record mutations at all, which would leave the operator with no record of
// a real event in exchange for a property they were not getting before this
// change anyway. Instead the entry is written unsigned, the reason is logged
// once, and Verify() reports could-not-verify for as long as the condition
// lasts — never "intact".
func New(path, imageDigest, instanceID string, opt Options) *Log {
	l := &Log{
		path:        path,
		imageDigest: imageDigest,
		instanceID:  instanceID,
		now:         func() float64 { return float64(time.Now().UnixNano()) / 1e9 },
		trustDir:    strings.TrimSpace(opt.TrustDir),
	}
	l.key, l.keyErr = loadKey(opt)
	// A trust root inside the log's own directory is not a trust root: anyone
	// who can rewrite the log can rewrite the key and reseal. Say so rather
	// than letting the deployment believe it has a property it does not.
	if l.key != nil && l.trustDir != "" {
		if abs, err := filepath.Abs(l.trustDir); err == nil {
			if logDir, err2 := filepath.Abs(filepath.Dir(path)); err2 == nil && abs == logDir {
				log.Printf("[audit] WARNING: the audit trust directory is the same directory as the log (%s); "+
					"anyone who can rewrite %s can also rewrite the key and reseal the chain. "+
					"Set AUDIT_TRUST_DIR (or AUDIT_KEY) to somewhere the log's writer cannot reach.",
					abs, filepath.Base(path))
			}
		}
	}
	return l
}

// KeyID is the short identifier of the key in use, or "" when there is none.
func (l *Log) KeyID() string { return l.key.ID() }

// KeySource names where the key came from, for the startup log line.
func (l *Log) KeySource() string { return l.key.Source() }

// KeyError is the reason no key could be established, or nil.
func (l *Log) KeyError() error { return l.keyErr }

// Read ports audit_read (server.py:2433): every non-blank JSONL line as a map.
// Numbers are decoded as json.Number so the exact on-disk token is preserved
// (a Python-written float ts round-trips byte-for-byte into the canonical hash
// input). A missing file is NOT an error — the log is genuinely empty — and
// returns (empty slice, 0, nil), matching Python's [].
//
// Any other open failure (permissions, path is a directory, IO error) returns
// a non-nil error. Individual lines that fail to decode are counted in
// skipped and excluded from the result rather than silently dropped with no
// trace; a scan failure partway through the file (e.g. a line exceeding the
// buffer cap) is also returned as an error, since everything after the
// failure point was never seen. Callers that need tamper-evidence guarantees
// (Verify) MUST check both the error and the skipped count — a short slice
// with err == nil and skipped == 0 is the only result that means "this really
// is the whole chain".
func (l *Log) Read() ([]map[string]any, int, error) {
	out := []map[string]any{}
	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return out, 0, nil
		}
		return out, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	skipped := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(line))
		dec.UseNumber()
		var e map[string]any
		if dec.Decode(&e) != nil {
			skipped++
			continue
		}
		out = append(out, e)
	}
	if err := sc.Err(); err != nil {
		return out, skipped, err
	}
	return out, skipped, nil
}

// entryHash ports _audit_entry_hash (server.py:2429): sha256 of the canonical
// JSON of every field except "hash" — and except "mac", which cannot be inside
// the thing it signs. Entries written before the keyed rewrite have no mac
// field, so their hash input, and therefore their hash, is untouched.
func (l *Log) entryHash(e map[string]any) (string, error) {
	payload := make(map[string]any, len(e))
	for k, v := range e {
		if k != "hash" && k != "mac" {
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
// hash (or 64 zeros), inject image_digest+instance_id into detail, hash, sign,
// and append one canonical JSON line, then reseal the head. The file line is
// written with the SAME canonical encoder used for hashing so the ts token on
// disk matches the hashed token exactly. Returns the written entry.
//
// A chain a caller cannot trust (unreadable, or with a dropped/undecodable
// line) must not be extended — appending onto an unverifiable prev_hash would
// either silently link onto garbage or silently drop the tamper-evidence
// property entirely. So Append refuses and returns an error instead of
// quarantining the bad tail and starting a fresh segment: a fresh segment
// would let the exact byte that broke the chain also erase the operator's
// only signal that it happened, since a new segment verifies clean on its
// own. Refusing keeps Verify() reporting the could-not-verify tri-state
// (verify_error, already wired to /api/audit/log and /api/audit/export) for
// as long as the corruption exists.
//
// Every caller in this codebase discards this method's error
// (`_, _ = Append(...)`), so a refusal that only returned an error would be
// invisible in practice — the whole point of "loud" is defeated if nothing
// ever looks at the return value. This log line is the guarantee: it fires
// here, once, regardless of which of the many call sites triggered it, so a
// stopped audit trail is never silent even when a caller forgets to check.
func (l *Log) Append(event, actor string, detail map[string]any) (map[string]any, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readOnly {
		return nil, errors.New("audit: this log was opened read-only for verification and cannot be appended to")
	}

	entries, skipped, err := l.Read()
	if err != nil {
		wrapped := fmt.Errorf("audit: cannot append, chain unreadable: %w", err)
		log.Printf("[audit] AUDIT LOGGING STOPPED: %v (event %q by %q was NOT recorded)", wrapped, event, actor)
		return nil, l.recordAppendFailure(event, actor, wrapped)
	}
	if skipped > 0 {
		wrapped := fmt.Errorf("audit: cannot append, chain read dropped %d line(s); prev hash cannot be trusted", skipped)
		log.Printf("[audit] AUDIT LOGGING STOPPED: %v (event %q by %q was NOT recorded)", wrapped, event, actor)
		return nil, l.recordAppendFailure(event, actor, wrapped)
	}
	prev := zeroHash
	if n := len(entries); n > 0 {
		if h, ok := entries[n-1]["hash"].(string); ok {
			prev = h
		}
	}
	d := map[string]any{}
	for k, v := range detail {
		// widen, not v: canonicalJSON's encoder is a closed type switch, and a
		// detail value outside it (a []string, a map[string]string) used to cost
		// the operator the whole entry. See widen.go.
		d[k] = widen(v)
	}
	d["image_digest"] = l.imageDigest
	d["instance_id"] = l.instanceID

	seq := len(entries)
	e := map[string]any{
		"ts":        json.Number(pyFloat(l.now())),
		"event":     event,
		"actor":     actor,
		"detail":    d,
		"prev_hash": prev,
		// seq is the running entry count the old chain had no equivalent of.
		// It is inside the hashed payload, so it is chained like everything
		// else and cannot be renumbered without breaking the following hashes.
		"seq": seq,
	}
	if l.key != nil {
		e["key_id"] = l.key.id
	} else {
		l.keyWarn.Do(func() {
			log.Printf("[audit] WARNING: entries are being written UNSIGNED because no audit key is available: %v. "+
				"The chain still detects corruption, but not an attacker who can write the log. "+
				"Verify() reports could-not-verify while this lasts.", l.keyErr)
		})
	}
	h, err := l.entryHash(e)
	if err != nil {
		return nil, l.recordAppendFailure(event, actor, err)
	}
	e["hash"] = h
	if l.key != nil {
		e["mac"] = entryMAC(l.key.secret, seq, h)
	}

	line, err := canonicalJSON(e)
	if err != nil {
		return nil, l.recordAppendFailure(event, actor, err)
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o755); err != nil {
		return nil, l.recordAppendFailure(event, actor, err)
	}
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, l.recordAppendFailure(event, actor, err)
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		return nil, l.recordAppendFailure(event, actor, err)
	}

	// Reseal. A failure here is logged but does not fail the append: the entry
	// is already durably on disk, and the alternative — reporting failure for a
	// write that succeeded — is its own lie. Verify tolerates a stale head that
	// is SHORT of the log as long as every entry past it is signed, so this
	// degrades to "truncation detection lags by n entries", not to a false
	// tamper verdict. See Verify.
	if l.key != nil {
		if err := l.writeHead(seq+1, h); err != nil {
			log.Printf("[audit] WARNING: entry recorded but the chain head could not be resealed: %v "+
				"(entries removed from the end may go undetected until the next successful append)", err)
		}
	}
	return e, nil
}

// Adopt seals the chain as it currently stands, so that a log written before
// the keyed rewrite — or one whose seal was lost with its trust directory —
// gains truncation detection from now on instead of reporting could-not-verify
// forever. Called once at startup.
//
// This is trust on first use, and the limit is worth stating plainly: adopting
// takes the log as it is at that moment. Anything already removed or edited
// before the first seal, by an attacker who got there first, is sealed in as
// legitimate. What it does buy is that every later removal is detected. Adopt
// refuses to seal a chain whose hash links are already broken, so it can never
// launder a visibly tampered log into a "valid" one.
//
// Returns nil when there was nothing to do (already sealed under this key).
func (l *Log) Adopt() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readOnly {
		return errors.New("audit: this log was opened read-only for verification and cannot be sealed")
	}

	if l.key == nil {
		return fmt.Errorf("audit: cannot seal the chain: %w", l.keyErr)
	}
	h, err := l.readHead()
	if err != nil {
		return fmt.Errorf("audit: existing head record could not be read: %w", err)
	}
	if h != nil && h.KeyID == l.key.id {
		return nil // already sealed under this key
	}
	entries, skipped, err := l.Read()
	if err != nil {
		return fmt.Errorf("audit: cannot seal, chain unreadable: %w", err)
	}
	if skipped > 0 {
		return fmt.Errorf("audit: cannot seal, chain read dropped %d line(s)", skipped)
	}
	if idx, _, ok := l.walkLinks(entries); !ok {
		return fmt.Errorf("audit: refusing to seal a chain that is already broken at entry %d", idx)
	}
	last := ""
	if n := len(entries); n > 0 {
		last, _ = entries[n-1]["hash"].(string)
	}
	if err := l.writeHead(len(entries), last); err != nil {
		return err
	}
	if h == nil {
		log.Printf("[audit] sealed the existing %d-entry chain under key %s (%s); entries removed from the end are detectable from now on",
			len(entries), l.key.id, l.key.source)
	} else {
		log.Printf("[audit] WARNING: the chain was sealed under key %s but this process holds key %s (%s); resealing at %d entries. "+
			"Entries signed with the old key can no longer be attested and will report could-not-verify.",
			h.KeyID, l.key.id, l.key.source, len(entries))
	}
	return nil
}

// walkLinks checks only the hash-chain structure — each entry's prev_hash link
// and recomputed hash. Returns (index, reason, false) at the first break.
func (l *Log) walkLinks(entries []map[string]any) (int, string, bool) {
	prev := zeroHash
	for i, e := range entries {
		ph, _ := e["prev_hash"].(string)
		want, _ := e["hash"].(string)
		got, err := l.entryHash(e)
		if err != nil {
			return i, "entry could not be hashed: " + err.Error(), false
		}
		if ph != prev {
			return i, "entry does not link to the one before it", false
		}
		if got != want {
			return i, "entry contents do not match its recorded hash", false
		}
		prev = want
	}
	return 0, "", true
}

// broken and cannotVerify build the two non-intact verdicts. Keeping them as
// constructors is what stops a fourth state creeping in.
func broken(index int, reason string) map[string]any {
	return map[string]any{"valid": false, "broken_index": index, "broken_reason": reason}
}

func cannotVerify(reason string) map[string]any {
	return map[string]any{"valid": false, "broken_index": nil, "verify_error": reason}
}

// readSkewHook is nil in production and exists so the ordering guarantee in
// Verify can be tested deterministically rather than by racing the scheduler.
// It is unexported and package-scoped, so nothing outside this package can set
// it and no build of the binary can reach it. A stochastic-only test for this
// defect would be a guard that passes for the wrong reason on a quiet machine.
var readSkewHook func()

// Verify walks the chain and returns a tri-state verdict, never a bool
// masquerading as one:
//
//   - {"valid": true,  "broken_index": nil}                      -> chain intact
//     (a genuinely empty, readable log counts as intact).
//   - {"valid": false, "broken_index": <int>, "broken_reason": …} -> tamper
//     detected. broken_index is the offending entry; for a truncated tail it is
//     the index of the first entry that should be there and is not, which may
//     equal the number of entries present. broken_reason is new and additive —
//     consumers that only read broken_index are unaffected.
//   - {"valid": false, "broken_index": nil, "verify_error": "…"}  -> the chain
//     could NOT be checked, so no verdict on tampering can be made. This case
//     must never collapse into "valid": true, and is told apart from the broken
//     case by broken_index being nil while verify_error is set.
//
// Three states, exactly as before. The keyed rewrite adds new REASONS to reach
// the second and third — a bad signature, a short chain, a key this process
// does not hold — but no fourth verdict.
//
// The distinction that matters most: a key that is missing, rotated or lost is
// could-not-verify, NOT tampering. Reporting "someone forged your audit log"
// because a config directory was wiped would be exactly the kind of invented
// certainty this codebase spent the week removing.
//
// READ ORDER IS LOAD-BEARING. The sealed head is read BEFORE the entries, and
// that is not a tidiness preference — it is the fix for a real defect. The
// other order let a concurrent Append (which writes the entry and THEN reseals
// the head) be observed as entries=N against a head recording N+1, and step 4
// below turned that into "N were removed from the end" — the tampered verdict,
// on a chain nobody touched. Reading the head first makes it the OLDER of the
// two snapshots, so an append in flight can only leave the log longer than the
// seal records, which is the stale-seal case Append already declares legitimate
// and step 4's final loop already handles. See issue #49.
//
// This ordering is what covers the offline verifier too, where no mutex can:
// `bloxsmith audit verify` opens a running server's log from another process.
// The one window ordering does NOT close is a partial final line written by
// another process, which still reads as could-not-verify rather than intact —
// wrong, but on the safe side of the tri-state, and never a tamper accusation.
func (l *Log) Verify() map[string]any {
	l.mu.RLock()
	defer l.mu.RUnlock()

	// Snapshot the head first, but hold its error and its verdicts until step 4:
	// an unreadable head must not mask a tampered ENTRY that steps 1-3 would
	// have caught, and moving the read forward must not move the verdict with it.
	h, headErr := l.readHead()

	// Test seam. Nil in production; the deterministic ordering test sets it to
	// append through a SECOND Log so the interleaving happens on every run
	// instead of when the scheduler obliges. It runs between the two reads
	// because that gap is the entire defect.
	if readSkewHook != nil {
		readSkewHook()
	}

	entries, skipped, err := l.Read()
	if err != nil {
		return cannotVerify(fmt.Sprintf("audit log could not be read: %v", err))
	}
	if skipped > 0 {
		return cannotVerify(fmt.Sprintf("audit log incomplete: %d line(s) could not be decoded", skipped))
	}

	// 1. Structure: the original unkeyed chain check, unchanged in behaviour.
	if idx, reason, ok := l.walkLinks(entries); !ok {
		return broken(idx, reason)
	}

	// 2. Position and signature, per entry. Entries written before the keyed
	//    rewrite carry neither and are skipped here; they are still covered
	//    collectively by the sealed head in step 4, because the hash chain
	//    means any edit to them changes the final hash.
	foreignKey := ""
	for i, e := range entries {
		if raw, ok := e["seq"]; ok {
			n, isNum := raw.(json.Number)
			v, nerr := int64(-1), error(nil)
			if isNum {
				v, nerr = n.Int64()
			}
			if !isNum || nerr != nil || int(v) != i {
				return broken(i, fmt.Sprintf("entry claims position %v but sits at position %d", raw, i))
			}
		}
		mac, hasMAC := e["mac"].(string)
		if !hasMAC {
			continue
		}
		kid, _ := e["key_id"].(string)
		if l.key == nil {
			foreignKey = kid
			continue
		}
		if kid != "" && kid != l.key.id {
			foreignKey = kid
			continue
		}
		hash, _ := e["hash"].(string)
		if !macEqual(mac, entryMAC(l.key.secret, i, hash)) {
			return broken(i, "entry signature does not match — it was written by something without the audit key")
		}
	}

	// 3. No key: the links are consistent, but nothing is attested and a
	//    truncated tail cannot be ruled out. That is not "intact".
	if l.key == nil {
		if len(entries) == 0 {
			return map[string]any{"valid": true, "broken_index": nil}
		}
		return cannotVerify(fmt.Sprintf(
			"no audit key is available, so the chain's signatures cannot be checked: %v", l.keyErr))
	}
	if foreignKey != "" {
		return cannotVerify(fmt.Sprintf(
			"entries are signed with audit key %s but this process holds %s; the chain may well be intact, but it cannot be checked with the key configured here",
			foreignKey, l.key.id))
	}

	// 4. The sealed head: how many entries there are supposed to be. Read at the
	//    top of this function; its error is adjudicated here, after the entry
	//    checks above, so the precedence between "an entry is forged" and "the
	//    head is unreadable" is exactly what it was before the read moved.
	if headErr != nil {
		return cannotVerify(fmt.Sprintf("the sealed head record could not be read: %v", headErr))
	}
	if h == nil {
		if len(entries) == 0 {
			return map[string]any{"valid": true, "broken_index": nil}
		}
		return cannotVerify(
			"this chain has never been sealed, so entries removed from the end cannot be detected; it is sealed at the next restart or audit event")
	}
	if h.KeyID != l.key.id {
		return cannotVerify(fmt.Sprintf(
			"the chain was sealed with audit key %s but this process holds %s, so the entry count cannot be checked", h.KeyID, l.key.id))
	}
	if !macEqual(h.MAC, headMAC(l.key.secret, h.Count, h.Hash)) {
		return broken(min(h.Count, len(entries)), "the sealed head record's own signature does not match — it was altered")
	}
	if len(entries) < h.Count {
		return broken(len(entries), fmt.Sprintf(
			"the log holds %d entries but the sealed head records %d — %d were removed from the end",
			len(entries), h.Count, h.Count-len(entries)))
	}
	if h.Count > 0 {
		sealed, _ := entries[h.Count-1]["hash"].(string)
		if sealed != h.Hash {
			return broken(h.Count-1, "the entry at the sealed position does not match the sealed hash")
		}
	}
	// A head SHORT of the log is legitimate only when every entry past it is
	// signed — that is the stale-seal case Append tolerates. An unsigned entry
	// appended past the seal is the downgrade attack: strip the signatures,
	// recompute the plain hashes, and the old verifier would have accepted it.
	for i := h.Count; i < len(entries); i++ {
		if _, ok := entries[i]["mac"].(string); !ok {
			return broken(i, "entry was appended after the sealed head without a signature")
		}
	}
	return map[string]any{"valid": true, "broken_index": nil}
}
