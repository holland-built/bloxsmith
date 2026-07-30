package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bloxsmith/internal/config"
	"bloxsmith/internal/rest"
	"bloxsmith/internal/vault"
)

// `bloxsmith restore-plan <export.json> --apply --confirm <target>` — actually
// re-create what a teardown deleted, from its export.
//
// restorecli.go's plan-only path never contacts a tenant. This does, and it is
// the one thing in this file that can make a live customer tenant look like it
// did before a mistaken teardown — or, done carelessly, make it look like
// something else entirely. Every check below exists because getting this wrong
// is not a bug report, it is a second incident stacked on the first one.
//
// THE WRITE LOCK IS HTTP MIDDLEWARE (internal/server/writelock.go) AND A CLI
// PROCESS DOES NOT PASS THROUGH IT. That is not a loophole this command uses —
// it is a gap this command has to close itself, by hand, using the exact same
// identity scheme and the exact same vault.WriteAllowed call the middleware
// uses. See applyRestore below and internal/vault/writelock.go for the model.
//
// HONESTY ABOUT WHAT IS PROVEN. The create call shapes here — POST bodies built
// from the export's own recorded object, minus its old id — are verified only
// against a fake upstream in restorecli_apply_test.go, never against a live
// Infoblox tenant. Re-creating a SUBNET at its original address is the sharpest
// edge: this codebase has no other exact-address subnet create anywhere to check
// the shape against, because real provisioning always allocates through
// nextavailablesubnet, a different operation that lets the API pick the
// address. That gap is stated here, in restoreUsage(), and again in this
// command's own output every time --apply runs — never claimed as proven.

// createPathByKind is the one create endpoint this build knows per object
// kind, taken from the paths internal/provision already uses to read and
// delete the same kinds of object. There is no "create at this exact address"
// surface documented anywhere else in this codebase to check these against —
// see the file doc comment above.
var createPathByKind = map[string]string{
	"subnet":        "/api/ddi/v1/ipam/subnet",
	"dhcp_range":    "/api/ddi/v1/ipam/range",
	"dns_zone":      "/api/ddi/v1/dns/auth_zone",
	"host":          "/api/ddi/v1/ipam/host",
	"address_block": "/api/ddi/v1/ipam/address_block",
}

// unverifiedAPINote is printed on every --apply run, success or failure alike.
// A limitation stated once in a usage screen nobody re-reads is not the same as
// stating it every time the risky thing is about to happen.
const unverifiedAPINote = "NOTE: the create call shapes used by --apply (especially re-creating a " +
	"subnet at its original address) are verified against a fake upstream in this build's own tests " +
	"— NOT against a live Infoblox tenant. This is not proven against the real API."

// applyOutcome is the result of one --apply run. Exactly one of Refused or
// StoppedAt is set on a run that did not finish cleanly. Created and Skipped
// are accurate up to whichever of those stopped it, so the caller can always
// report exactly what already happened — never "something may have been
// created," always a list.
type applyOutcome struct {
	Refused    string        // non-empty: refused before creating anything. Nothing was created.
	Created    []restoreStep // objects actually created, in the order they were created
	Skipped    []restoreStep // objects found to already exist upstream, not re-created
	StoppedAt  *restoreStep  // non-nil: creation stopped here, after a failure
	StoppedErr error         // set iff StoppedAt != nil
}

// applyRestore is the whole safety-plus-create pipeline, deliberately
// independent of the CLI's own vault/flag plumbing (runRestoreApplyCLI below)
// so it can be driven directly against a fake upstream in tests, with the
// identity and write-lock answer handed in rather than resolved from a real
// vault on disk.
//
// client must already be the tenant's rest client. currentID is this
// process's resolved write identity (vault.WriteID(vaultTenant, cspAccount) —
// see internal/vault/writelock.go); writable is whether that identity has been
// marked writable; confirm is the --confirm flag's value, compared to the
// export's own target.
func applyRestore(client *rest.Client, doc *exportDoc, steps []restoreStep, currentID string, writable bool, confirm string) *applyOutcome {
	// 1. TENANT MATCH. Checked first, and entirely locally — no network call
	// can answer this, only the export's own recorded identity can. An export
	// with no recorded tenant is refused rather than assumed to be "this one":
	// str() returns "" for a nil/absent map, which is indistinguishable from an
	// export that recorded an empty tenant, and both must refuse the same way.
	exportID := strings.TrimSpace(str(doc.Tenant, "id"))
	switch {
	case exportID == "":
		return &applyOutcome{Refused: "this export does not record which tenant it came from. " +
			"Re-creating into the wrong tenant is the same mistake as tearing down the wrong one — " +
			"refusing rather than assuming it is this one. Nothing was created."}
	case exportID != currentID:
		return &applyOutcome{Refused: fmt.Sprintf(
			"this export is from tenant %q, but the tenant resolved right now is %q. Re-creating a site "+
				"into the wrong tenant is the same disaster as tearing down the wrong one. Nothing was created.",
			exportID, currentID)}
	}

	// 2. WRITE LOCK. The CLI-side equivalent of internal/server/writelock.go's
	// withWriteLock, which never runs for a CLI process. Same identity, same
	// default of read-only, no override.
	if !writable {
		return &applyOutcome{Refused: fmt.Sprintf(
			"%s is not marked writable. Mark it writable in Settings before restoring into it — the same "+
				"control every write route on the running server is gated by. Nothing was created.", currentID)}
	}

	// 3. TYPED CONFIRMATION. Must name the exact target, the same discipline
	// the teardown routes require (?confirm=<site>, ?confirm=DELETE). A blank
	// or mismatched confirm refuses — never a fuzzy or case-insensitive match.
	if confirm == "" || confirm != doc.Target {
		return &applyOutcome{Refused: fmt.Sprintf(
			"refusing without --confirm %s. Nothing was created.", doc.Target)}
	}

	var created, skipped []restoreStep
	for i := range steps {
		s := steps[i]

		if s.Prereq {
			// 6. Prerequisites (ip_space, dns_view) are NEVER created — a
			// teardown never deletes them. If one is not there now, something
			// else removed it since, and creating everything downstream of it
			// would build a site on a foundation this tool has no business
			// inventing. Refuse and say which.
			exists, err := objectExists(client, s.Body)
			if err != nil {
				return &applyOutcome{Created: created, Skipped: skipped, StoppedAt: &s, StoppedErr: err}
			}
			if !exists {
				return &applyOutcome{Refused: fmt.Sprintf(
					"prerequisite %s %q is missing upstream. It was never deleted by the teardown this "+
						"export records, so this tool will not create it — fix that first. Nothing was created.",
					s.Kind, s.Name)}
			}
			continue
		}

		// 4. SKIP WHAT EXISTS. A teardown that failed partway can leave an
		// object the export lists as "about to be deleted" still very much
		// there — the export is a SUPERSET of what actually went (see
		// internal/provision/export.go). Re-creating it would duplicate it.
		//
		// This checks the id the export recorded — the same id the original
		// delete call used — not a match on address/fqdn/name. That is
		// deliberately narrow: it catches exactly the case above, and it does
		// NOT catch "a previous --apply run already re-created this under a
		// new id," which would need a content match and risks matching the
		// WRONG object. Stated limit, not an oversight.
		exists, err := objectExists(client, s.Body)
		if err != nil {
			return &applyOutcome{Created: created, Skipped: skipped, StoppedAt: &s, StoppedErr: err}
		}
		if exists {
			skipped = append(skipped, s)
			continue
		}

		path, ok := createPathByKind[s.Kind]
		if !ok {
			return &applyOutcome{Created: created, Skipped: skipped, StoppedAt: &s,
				StoppedErr: fmt.Errorf("no create endpoint known for kind %q", s.Kind)}
		}
		_, status, err := client.Write("POST", path, stripCreateID(s.Body), nil)
		// 5. STOP ON FIRST FAILURE. A transport error and a non-2xx status are
		// both a stop, not a skip and not a continue — the operator needs to
		// know the plan's dependency order was broken here, not past it.
		if err != nil {
			return &applyOutcome{Created: created, Skipped: skipped, StoppedAt: &s, StoppedErr: err}
		}
		if status < 200 || status >= 300 {
			return &applyOutcome{Created: created, Skipped: skipped, StoppedAt: &s,
				StoppedErr: fmt.Errorf("upstream returned status %d creating %s %q", status, s.Kind, s.Name)}
		}
		created = append(created, s)
	}
	return &applyOutcome{Created: created, Skipped: skipped}
}

// objectExists asks whether the object THIS EXPORT RECORDED — by the id its
// original delete call used — is still there. See the "SKIP WHAT EXISTS"
// comment in applyRestore for why that is the right and deliberately narrow
// question to ask.
//
// A step whose body has no recorded id cannot be checked safely at all: race
// ahead and create it, and a live object could get duplicated with nothing
// having actually been checked. That is a stop, the same as any other failure
// to determine what is safe to do next.
func objectExists(client *rest.Client, body any) (bool, error) {
	id := strings.TrimSpace(str(asObj(body), "id"))
	if id == "" {
		return false, fmt.Errorf("this step's export entry has no recorded id — whether it already exists upstream cannot be checked safely")
	}
	_, status, err := client.GetEx("/api/ddi/v1/"+id, nil)
	if err != nil {
		return false, fmt.Errorf("could not check whether %s already exists upstream: %w", id, err)
	}
	switch {
	case status >= 200 && status < 300:
		return true, nil
	case status == 404:
		return false, nil
	default:
		return false, fmt.Errorf("could not check whether %s already exists upstream: status %d", id, status)
	}
}

// stripCreateID returns a shallow copy of body with its "id" key removed, when
// body is an object at all. The id on a recorded object is the id of the thing
// that no longer exists (or this step would have been skipped); sending it on
// a create call is never right, whatever the real create endpoint turns out to
// want back.
func stripCreateID(body any) any {
	m := asObj(body)
	if m == nil {
		return body
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		if k == "id" {
			continue
		}
		out[k] = v
	}
	return out
}

// runRestoreApplyCLI resolves this machine's vault and config the same way
// buildServer (main.go) does for the running server, then runs applyRestore
// and reports the outcome.
//
// WHY THIS DUPLICATES THAT WIRING RATHER THAN REUSING IT: this is a one-shot
// CLI process, not the server — there is no running Deps to call into, and no
// inbound HTTP request for internal/server/writelock.go's withWriteLock to run
// against at all. The write lock is enforced HERE, by hand, using the exact
// same vault.WriteID / WriteAllowed calls the middleware uses. See the package
// doc comment above for why that is not a weaker check than the one the server
// runs — it is the same check, run from the only place that can run it here.
func runRestoreApplyCLI(path string, doc *exportDoc, steps []restoreStep, confirm string) int {
	dir := "."
	if exe, err := os.Executable(); err == nil {
		dir = filepath.Dir(exe)
	}
	// Same env-loading discipline as passcli.go: always, not only when a flag
	// was omitted, so this command's idea of the vault matches the server's.
	config.LoadDotEnv(filepath.Join(dir, ".env"))
	config.LoadDotEnv(".env")
	config.LoadServiceEnv()
	cfg := config.Load(dir)

	v := vault.New(vault.ResolveFile(cfg.VaultDir, dir))
	v.BaseURL = cfg.BaseURL
	pass, _, warn := vault.ResolvePassphrase(v.Path(), cfg.VaultPassphrase, cfg.VaultPassphraseFile)
	if warn != "" {
		fmt.Fprintf(os.Stderr, "restore-plan --apply: [vault] %s\n", warn)
	}
	if pass == "" {
		fmt.Fprintln(os.Stderr, "restore-plan --apply: no vault auto-unlock passphrase is configured "+
			"(VAULT_PASSPHRASE, VAULT_PASSPHRASE_FILE, or the macOS keychain) — this command cannot prompt "+
			"for one. Unlock the vault another way first, e.g. from the running server's browser UI. "+
			"Nothing was created.")
		return 1
	}
	if _, err := v.AutoUnlock(pass); err != nil {
		fmt.Fprintf(os.Stderr, "restore-plan --apply: could not unlock the vault: %v. Nothing was created.\n", err)
		return 1
	}
	defer v.Lock()

	// Same single mutable auth slot buildServer wires: active tenant key, else
	// the env API_KEY fallback (main.go:318).
	auth := rest.NewAuth(cfg.APIKey, v.ActiveKey)
	client := rest.New(cfg.BaseURL, auth)

	// The identity a write from this process would land under. No portal
	// account switch exists in a CLI process, so this always uses
	// vault.NoSwitch — there is no account.Manager here to ask, and no
	// switched-in JWT could be in force outside a running server's request
	// handling.
	currentID := vault.WriteID(v.ActiveTenantID(), vault.NoSwitch)
	writable := v.WriteAllowed(currentID)

	outcome := applyRestore(client, doc, steps, currentID, writable, confirm)
	return printApplyOutcome(doc, outcome)
}

// printApplyOutcome reports exactly what happened — including, on a stop, the
// partial state — and returns the process exit code.
func printApplyOutcome(doc *exportDoc, o *applyOutcome) int {
	fmt.Println(unverifiedAPINote)
	fmt.Println()

	if o.Refused != "" {
		fmt.Fprintf(os.Stderr, "restore-plan --apply: refused: %s\n", o.Refused)
		return 1
	}

	for _, s := range o.Skipped {
		fmt.Printf("  skip    %-13s %s  (already exists upstream)\n", s.Kind, s.Name)
	}
	for _, s := range o.Created {
		fmt.Printf("  created %-13s %s\n", s.Kind, s.Name)
	}

	if o.StoppedAt != nil {
		fmt.Fprintf(os.Stderr, "\nrestore-plan --apply: STOPPED at %s %q: %v\n",
			o.StoppedAt.Kind, o.StoppedAt.Name, o.StoppedErr)
		fmt.Fprintf(os.Stderr, "%d object(s) were created before it stopped (listed above); "+
			"the rest of the plan was NOT applied.\n", len(o.Created))
		return 1
	}

	fmt.Printf("\n%d created, %d already existed and were skipped. Restore of %q complete.\n",
		len(o.Created), len(o.Skipped), doc.Target)
	return 0
}
