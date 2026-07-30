package server

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"

	"bloxsmith/internal/ai"
	"bloxsmith/internal/dashboard"
	"bloxsmith/internal/edit"
	"bloxsmith/internal/provision"
	"bloxsmith/internal/rest"
)

// Request-scoped tenant binding.
//
// THE DEFECT. auth.SetOverride writes a single process-global slot, and every
// outbound REST call read it afresh. One inbound request makes many outbound
// calls — /api/data fans out across a dozen fetchers, and a provisioning or
// decommission stream makes dozens over minutes — so an account switch landing
// midway left the first half of a request running against tenant A and the rest
// against tenant B, with nothing anywhere saying so. The worst case is not a
// muddled dashboard: it is a teardown that starts deleting subnets and DNS
// zones in tenant A and finishes deleting them in tenant B.
//
// THE FIX. The Authorization value is resolved ONCE, here, at the top of every
// request, into a pinned rest.Client carried on the request context. Handlers
// reach their dependencies through the accessors below, which hand back copies
// bound to that pinned client. A switch therefore takes effect on the NEXT
// request — which is what someone clicking "switch account" expects anyway.
//
// WHAT IS DELIBERATELY NOT PINNED. The account manager (d.Account) is the thing
// that performs the switch; it must see live state, so it keeps its own auth
// path. Background work belongs to no request and likewise resolves live. And
// the vault gate reads d.Auth.Value() directly on purpose: "is any key active
// at all" is a question about now, not about this request.
//
// The homeVerified guard in account.go is untouched and still correct.

type ctxKey int

const pinnedRestKey ctxKey = iota

// withPinnedTenant resolves the outbound credential once and puts the resulting
// request-scoped rest.Client on the context. It runs before routing, so every
// handler underneath sees the same tenant for its whole lifetime — including SSE
// streams, which simply hold the request open.
func (d *Deps) withPinnedTenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d.Rest == nil {
			next.ServeHTTP(w, r)
			return
		}
		ctx := context.WithValue(r.Context(), pinnedRestKey, d.Rest.Pin())
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// pinFrom returns the request's pinned client, or nil when there is none —
// a handler called directly by a test, or an internal call with no request.
func pinFrom(r *http.Request) *rest.Client {
	if r == nil {
		return nil
	}
	c, _ := r.Context().Value(pinnedRestKey).(*rest.Client)
	return c
}

// restFor returns the request's pinned client, falling back to the shared one.
func (d *Deps) restFor(r *http.Request) *rest.Client {
	if c := pinFrom(r); c != nil {
		return c
	}
	return d.Rest
}

// The accessors below rebind ONLY when there is something to rebind to. An
// earlier version always called With(d.restFor(r)), which handed a nil client
// to every holder in tests that wire a Dashboard without a Deps.Rest — four
// /api/incidents tests panicked. Leaving the holder's own client in place when
// there is no pin is both safer and the honest default: no request, no pin.

func (d *Deps) dash(r *http.Request) *dashboard.Service {
	if d.Dashboard == nil {
		return nil
	}
	if c := pinFrom(r); c != nil {
		return d.Dashboard.With(c)
	}
	return d.Dashboard
}

func (d *Deps) editFor(r *http.Request) *edit.Client {
	if d.Edit == nil {
		return nil
	}
	if c := pinFrom(r); c != nil {
		return d.Edit.With(c)
	}
	return d.Edit
}

func (d *Deps) prov(r *http.Request) *provision.Engine {
	if d.Provision == nil {
		return nil
	}
	e := d.Provision
	if c := pinFrom(r); c != nil {
		e = e.With(c)
	}
	return e.WithExport(d.exportWriter())
}

// exportDirName is the subdirectory of StateDir that holds teardown exports. A
// directory rather than loose files in StateDir, so a state dir that already
// holds vault.json, .env, the audit log and first_seen.json stays navigable —
// and so one chmod covers every export.
const exportDirName = "teardown-exports"

// exportWriter builds the per-request recorder for what a teardown is about to
// delete. Per-request because the tenant identity it stamps has to be resolved
// per request; see internal/server/writelock.go.
//
// A Deps with no StateDir yields a writer with no Dir, which makes every teardown
// REFUSE (provision/export.go) rather than run unrecorded. That is the intended
// behaviour for a misconfigured install, not a gap: the alternative is deleting a
// live tenant's zones with no record because a path was empty.
func (d *Deps) exportWriter() *provision.ExportWriter {
	dir := ""
	if strings.TrimSpace(d.StateDir) != "" {
		dir = filepath.Join(d.StateDir, exportDirName)
	}

	// The SAME identity the write lock checked, resolved the same way. An export
	// that named a different tenant than the one approved would be worse than
	// none: it would send a rebuild at the wrong tenant.
	id, unknown := d.writeIdentity()
	label := ""
	if unknown != "" {
		// Cannot happen through a gated route — the lock refuses "unknown" before
		// any handler runs. Recorded as the reason rather than left blank anyway,
		// because a blank tenant in a recovery file reads as "no switch was in
		// force", which would be a fabricated fact.
		id = ""
		label = "unknown: " + unknown
	} else if d.Vault != nil {
		label = d.Vault.LabelForTenantID(strings.SplitN(id, "/", 2)[0])
	}

	return &provision.ExportWriter{
		Dir:         dir,
		Tenant:      id,
		TenantLabel: label,
		Version:     d.Version,
	}
}

func (d *Deps) aiFor(r *http.Request) *ai.Service {
	if d.AI == nil {
		return nil
	}
	if ds := d.dash(r); ds != nil && pinFrom(r) != nil {
		return d.AI.With(ds)
	}
	return d.AI
}
