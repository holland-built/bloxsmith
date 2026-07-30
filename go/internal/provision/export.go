package provision

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// WRITE OUT WHAT IS ABOUT TO BE DELETED, BEFORE IT IS DELETED.
//
// Teardown deletes real DNS zones, subnets, DHCP ranges, hosts and address
// blocks in a live customer tenant, and it is FAIL-FORWARD by construction: no
// rollback, every step a delete (see SiteDecommissioner). Up to now a mistake was
// logged — emitIncomplete names what is already gone — which explains the loss
// without undoing it. "Which subnets did I just delete" was answerable; "put them
// back" was not.
//
// So before the first delete, the plan is written to a file: the full object
// bodies as the API returned them, enough to rebuild rather than enough to
// describe.
//
// A TEARDOWN THAT COULD NOT BE RECORDED DOES NOT RUN. That is the whole point and
// it is why every failure below returns an error instead of emitting a warning.
// An unrecoverable teardown is the thing being prevented; failing to record one
// is a reason to stop, not something to log past on the way to deleting 487
// subnets. The refusals happen before any delete, so a refused teardown has
// changed nothing.
//
// WHAT THIS FILE IS NOT.
//
// It is not proof of what was deleted. It is the plan as it stood immediately
// before the first delete — if a delete fails partway, the export still lists
// everything that was going to go, which makes it a SUPERSET of what actually
// went. The run summary and emitIncomplete are what say how far the run got.
// Overstating this as a deletion receipt would be the kind of claim this codebase
// keeps refusing to make.
//
// It is not a restore tool. Nothing here re-creates anything; the operator (or a
// later feature) has the bodies to do it with. Writing an untested restore path
// and calling the problem solved would be worse than being honest that this is
// the record and the rebuild is manual.
//
// A NEW PLACE TENANT DATA SITS ON DISK, said plainly because it is a real cost.
// These files hold zone FQDNs, internal addressing and host names in plaintext,
// 0600, in the same state directory as audit_log.jsonl. They are NOT encrypted
// into the vault, deliberately: an export that needs the vault open to read is
// useless in exactly the situation it exists for, and the audit log beside it is
// already plaintext for the same reason. Nothing prunes them — an export deleted
// automatically after N days is an export missing when someone finally notices
// what went, and a state directory the operator can see and manage is better than
// a retention policy nobody remembers.

// exportFormat is the version stamp in every file. Anything reading these later
// must be able to tell which shape it is looking at rather than guessing from
// which keys happen to be present.
const exportFormat = 1

// The two kinds of teardown that delete tenant objects, and therefore the two
// that record first. They appear in the filename, so they are short and stable.
const (
	exportKindSite  = "teardown-site"
	exportKindBlock = "teardown-block"
)

// ExportWriter records a teardown plan to a file. The provision package owns the
// FORMAT; the caller owns the tenant identity, because only the request layer
// knows which tenant the write lock approved.
type ExportWriter struct {
	// Dir is the directory the file lands in. Empty is not a default — see
	// Write, which refuses rather than picking somewhere.
	Dir string

	// Tenant is the opaque write identity (vault.WriteID) this teardown was
	// approved for, and TenantLabel its human name. Both are recorded because an
	// export that does not say WHICH TENANT it came from cannot be used to
	// rebuild into the right one — which is the mistake v3.23.0 and v3.27.0 were
	// both about. Unknown is written as the empty string and never guessed.
	Tenant      string
	TenantLabel string

	// Version stamps which build wrote the file.
	Version string

	// Now is injectable so a test can assert the exact filename. nil means
	// time.Now.
	Now func() time.Time
}

func (w *ExportWriter) now() time.Time {
	if w == nil || w.Now == nil {
		return time.Now()
	}
	return w.Now()
}

// safeTargetChars keeps a filename derived from tenant-supplied values (a site
// name comes from a template, an address-block name from YAML) from reaching
// outside Dir or colliding with a path separator. Anything else becomes "-", and
// the value is recorded verbatim INSIDE the file, so nothing is lost by the
// filename being conservative.
func safeTarget(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		// An unnamed target still gets a file. "unnamed" is a description of the
		// input, not an invented value standing in for a real name — the real
		// (empty) name is in the file's target field.
		return "unnamed"
	}
	if len(out) > 60 {
		out = out[:60]
	}
	return out
}

// PlannedPath is the file this run WOULD write. It is what a dry run reports:
// the operator gets to check the location before a real run puts anything there.
// It creates nothing.
func (w *ExportWriter) PlannedPath(kind, target string) string {
	dir := ""
	if w != nil {
		dir = w.Dir
	}
	// A timestamp form that sorts lexically and has no characters needing quoting
	// in a shell. UTC so two runs either side of a DST change still sort.
	stamp := w.now().UTC().Format("20060102T150405Z")
	return filepath.Join(dir, fmt.Sprintf("%s-%s-%s.json", stamp, kind, safeTarget(target)))
}

// Write records the plan and returns the path written.
//
// Every error here stops the teardown. They are all "the record did not land",
// which is the one condition under which not deleting is the right outcome.
func (w *ExportWriter) Write(kind, target string, plan M) (string, error) {
	if w == nil || strings.TrimSpace(w.Dir) == "" {
		// Not configured. Refusing beats picking a directory: an export written
		// somewhere the operator does not know to look is indistinguishable from
		// no export at the moment they need it.
		return "", perr("refusing to tear down: no directory is configured to write the " +
			"record of what would be deleted, so this teardown could not be undone. Nothing was changed.")
	}
	if err := os.MkdirAll(w.Dir, 0o700); err != nil {
		return "", perr("refusing to tear down: could not create the directory for the record of what "+
			"would be deleted (%s): %s. Nothing was changed.", w.Dir, err.Error())
	}

	body := M{
		"bloxsmith_export":  exportFormat,
		"kind":              kind,
		"written_at":        w.now().UTC().Format(time.RFC3339),
		"bloxsmith_version": w.Version,
		"tenant":            M{"id": w.Tenant, "label": w.TenantLabel},
		"target":            target,
		// The caller's plan, with the full API bodies in it.
		"plan": plan,
		// Said inside the file as well as here, because whoever opens it in six
		// months will not have read this source file.
		"note": "This is what a teardown was ABOUT TO DELETE, recorded before the first delete. " +
			"It is a superset of what was actually deleted: if the run failed partway, objects listed " +
			"here may still exist. It is a record for rebuilding by hand, not a restore tool, and not " +
			"a receipt of deletion.",
	}

	b, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		// Refuses rather than writing a partial file: a truncated export read as
		// complete is worse than a teardown that did not happen.
		return "", perr("refusing to tear down: the record of what would be deleted could not be "+
			"encoded (%s). Nothing was changed.", err.Error())
	}
	b = append(b, '\n')

	path := w.PlannedPath(kind, target)

	// Written to a temp file and then linked into place, so a crash mid-write
	// cannot leave a half-written export that a later reader takes for the whole
	// plan. CreateTemp gives a unique name, so two runs in flight at once cannot
	// collide on the scratch file.
	f, err := os.CreateTemp(w.Dir, ".partial-*")
	if err != nil {
		return "", perr("refusing to tear down: could not open the record of what would be deleted "+
			"for writing (in %s): %s. Nothing was changed.", w.Dir, err.Error())
	}
	tmp := f.Name()
	// CreateTemp already makes it 0600, but this file holds tenant addressing, so
	// the permission is asserted rather than assumed.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", perr("refusing to tear down: could not restrict permissions on the record of what "+
			"would be deleted (%s): %s. Nothing was changed.", tmp, err.Error())
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", perr("refusing to tear down: could not write the record of what would be deleted "+
			"(%s): %s. Nothing was changed.", tmp, err.Error())
	}
	// Fsync before it goes into place. Without it the teardown can proceed on the
	// strength of a file that is only in the page cache, and the one failure this
	// export exists for — something going badly wrong on this machine — is also
	// the one most likely to lose it.
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return "", perr("refusing to tear down: could not flush the record of what would be deleted "+
			"to disk (%s): %s. Nothing was changed.", tmp, err.Error())
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", perr("refusing to tear down: could not close the record of what would be deleted "+
			"(%s): %s. Nothing was changed.", tmp, err.Error())
	}

	// LINK, NOT RENAME. os.Rename silently replaces an existing file, so two
	// teardowns of the same target within the same second would leave ONE record
	// — the second quietly destroying the first run's only copy of what it
	// deleted. os.Link fails with EEXIST instead, which turns that into a refusal
	// before anything is deleted. Found by a test; rename passed everything else.
	if err := os.Link(tmp, path); err != nil {
		os.Remove(tmp)
		if errors.Is(err, fs.ErrExist) {
			return "", perr("refusing to tear down: a record of a teardown of this target at this "+
				"timestamp already exists (%s), and overwriting it would destroy the only copy of what "+
				"that run deleted. Nothing was changed.", path)
		}
		return "", perr("refusing to tear down: could not put the record of what would be deleted in "+
			"place (%s): %s. Nothing was changed.", path, err.Error())
	}
	// The link succeeded, so the content is at `path` under its own name; the
	// scratch name is now redundant. A failure to remove it leaves a stray dotfile
	// and nothing worse, so it is not a reason to refuse a teardown whose record
	// is safely on disk.
	os.Remove(tmp)

	// Read back and re-parse. The file is the only thing standing between a
	// mistake and an unrecoverable one, and "it wrote without erroring" is not
	// the same claim as "it is on disk and parses" — the same read-back
	// SetKeychainPassphrase does, for the same reason: the operator is about to
	// rely on it.
	got, err := os.ReadFile(path)
	if err != nil {
		return "", perr("refusing to tear down: the record of what would be deleted was written but "+
			"could not be read back (%s): %s. Nothing was changed.", path, err.Error())
	}
	var check map[string]any
	if err := json.Unmarshal(got, &check); err != nil {
		return "", perr("refusing to tear down: the record of what would be deleted was written but "+
			"does not parse (%s): %s. Nothing was changed.", path, err.Error())
	}
	return path, nil
}
