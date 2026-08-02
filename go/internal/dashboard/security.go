package dashboard

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"bloxsmith/internal/mcp"
)

// This file ports the security-policy write engine (server.py:4554-4593):
// block_domain / unblock_domain. Both validate the domain against a strict FQDN
// regex and require an allowlisted BLOCK_LIST_ID (never a fuzzy name match),
// then patch/delete the named-list item via the MCP portal write tools. The
// route layer adds the X-Auth-Token gate + audit entry (server.py:6110/6127).
//
// Live-proven bug this file fixes: the write tools' success payload shape is
// UNOBSERVED here (no BLOCK_LIST_ID was configured when this was traced, so a
// real success reply was never captured) — but upstream tool REJECTIONS
// arrive as ordinary payloads with a transport-level err == nil. Reporting
// success on `err == nil` alone told an operator a malicious domain was
// blocked when it was not. The fix: CallToolChecked is used only to catch a
// genuine TRANSPORT failure (never guessing a success predicate for an
// unobserved shape — see BlockDomain/UnblockDomain), and the named list is
// then read back to prove the list's actual final state.

// blockListRE is _TABLE_RE (server.py:173): the block-list id must match before
// it is interpolated into the endpoint path.
var blockListRE = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,127}$`)

// Four outcomes, and only four: "invalid" (a local fault, detected before any
// request is built — nothing was ever sent upstream; fix the request or config
// and retry), "rejected" (a transport error, which does NOT mean upstream
// refused it — see isMcpTransportError: the write may already have landed, so
// the outcome is unknown and the audit log records it), "verified" (read-back
// confirms the desired state), "unverified" (submitted, but convergence wasn't
// observed within the budget; refresh before retrying).

// --- read-back verification budget ------------------------------------------
//
// This is on the write hot path, so it is deliberately small and bounded:
//   - verifyAttempts GETs of the named list (each a fresh snapshot),
//   - verifyReadTimeout caps each individual GET so one hung request can't
//     stall the whole call,
//   - verifyBackoff idles between attempts to give eventual consistency /
//     caching a chance to converge,
//   - verifyMaxItems caps how much of an unexpectedly huge item list is
//     scanned per attempt.
//
// Worst-case wall clock ≈ verifyAttempts * (verifyReadTimeout + verifyBackoff)
// = 3 * (5s + 1s) = 18s.
const (
	verifyAttempts    = 3
	verifyReadTimeout = 5 * time.Second
	verifyBackoff     = 1 * time.Second
	verifyMaxItems    = 20000
)

// canonDomain normalises a domain for comparison: whitespace trimmed, a
// single trailing dot stripped, and ASCII-lower-cased. Used on BOTH the
// submitted domain and every item read back, so a service-side normalization
// on either side can never manufacture a false mismatch.
//
// KNOWN LIMITATION: this does NOT handle internationalised/punycode
// equivalence (e.g. a unicode domain vs. its "xn--" ASCII form comparing
// equal). Doing that requires golang.org/x/net/idna, which pulls in
// golang.org/x/net and golang.org/x/text and forces golang.org/x/crypto down
// a minor version to satisfy their shared go.mod graph — downgrading a
// crypto dependency (used here for vault and update-signature verification)
// to gain IDNA matching in a security-hardening change is a bad trade, so it
// is deliberately left unhandled.
func canonDomain(d string) string {
	d = strings.ToLower(strings.TrimSpace(d))
	d = strings.TrimSuffix(d, ".")
	return d
}

// isMcpTransportError reports whether err came from CallToolChecked's
// TRANSPORT-error branch rather than its fail-closed branch (a
// decoded-or-undecodable payload that didn't match the success predicate).
//
// WHAT IT DOES NOT TELL YOU: whether the write reached the tool.
// CallToolChecked wraps every error out of CallTool as ErrTransport, and that
// covers the 12s call timeout expiring AFTER the PATCH/DELETE was dispatched,
// an HTTP status >= 400 from the gateway once the tool may already have
// executed, a response-body read failure after it ran, a JSON decode failure
// after it ran, and a JSON-RPC error in the reply. At this layer "never sent"
// and "sent, outcome unknown" are indistinguishable, so a true result means
// UNKNOWN — not "nothing was applied" — and the caller's "rejected" outcome is
// recorded in the audit log for exactly that reason (server/security.go's
// auditOutcome). Retrying is safe only because these two writes are idempotent,
// not because the first attempt is known to have missed.
//
// Block/unblock pass a nil predicate below because the success shape for these
// two tools has never been observed live, so the fail-closed branch fires on
// every call regardless of whether the write actually succeeded upstream.
// Ground truth comes from the named-list read-back, never from guessing a
// predicate. Matches via errors.Is against the mcp package's exported sentinel
// rather than the error's message text, which is free to be reworded without
// notice.
func isMcpTransportError(err error) bool {
	return errors.Is(err, mcp.ErrTransport)
}

// namedListItems fetches the named list and returns its canonicalised item
// set. Bounded by verifyReadTimeout regardless of the underlying REST
// client's own timeout, since GetEx takes no context.
func (s *Service) namedListItems(blockListID string, timeout time.Duration) ([]string, error) {
	type result struct {
		body   any
		status int
		err    error
	}
	ch := make(chan result, 1)
	go func() {
		body, status, err := s.Rest.GetEx("/api/atcfw/v1/named_lists/"+blockListID, nil)
		ch <- result{body, status, err}
	}()

	select {
	case r := <-ch:
		if r.err != nil {
			return nil, r.err
		}
		if r.status >= 400 {
			return nil, fmt.Errorf("named list read-back: http %d", r.status)
		}
		m := asMap(r.body)
		if inner, ok := m["result"].(map[string]any); ok {
			m = inner
		}
		raw := asSlice(m["items"])
		if len(raw) > verifyMaxItems {
			raw = raw[:verifyMaxItems]
		}
		items := make([]string, 0, len(raw))
		for _, it := range raw {
			if str, ok := it.(string); ok {
				items = append(items, canonDomain(str))
			}
		}
		return items, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("named list read-back: timed out after %s", timeout)
	}
}

// verifyState polls the named list, within the read-back budget above, until
// domain's presence matches wantPresent. This proves the LIST'S final state —
// not that this specific call caused it, since the domain may already have
// been present/absent before the write. Returns false when the budget is
// exhausted without convergence (caller reports "unverified", not "rejected":
// eventual consistency/caching can hide an already-committed write).
func (s *Service) verifyState(blockListID, domain string, wantPresent bool) bool {
	target := canonDomain(domain)
	for attempt := 0; attempt < verifyAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(verifyBackoff)
		}
		items, err := s.namedListItems(blockListID, verifyReadTimeout)
		if err != nil {
			continue
		}
		present := false
		for _, it := range items {
			if it == target {
				present = true
				break
			}
		}
		if present == wantPresent {
			return true
		}
	}
	return false
}

// verifyOutcome builds the verified/unverified result once a write has been
// submitted without a transport-level rejection. detail is the write tool's
// raw reply, kept only as diagnostic context — see the file-level comment on
// why it cannot be trusted as a success signal by itself.
func (s *Service) verifyOutcome(blockListID, domain string, wantPresent bool, detail string) map[string]any {
	state := "absent from"
	if wantPresent {
		state = "present in"
	}
	if s.verifyState(blockListID, domain, wantPresent) {
		return map[string]any{
			"ok": true, "outcome": "verified", "domain": domain, "list": blockListID,
			"message": fmt.Sprintf("read-back confirms %s is %s block list %s (this proves the list's current state, not that this call caused it)", domain, state, blockListID),
			"detail":  detail,
		}
	}
	return map[string]any{
		"ok": false, "outcome": "unverified", "domain": domain, "list": blockListID,
		"error":  fmt.Sprintf("write submitted but read-back did not confirm %s is %s block list %s within the verification budget; the mutation may already have landed — refresh and re-check before retrying", domain, state, blockListID),
		"detail": detail,
	}
}

// BlockDomain is block_domain (server.py:4574 / _block_domain_async 4556).
func (s *Service) BlockDomain(ctx context.Context, domain, blockListID string) map[string]any {
	if !isFQDN(domain) {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "invalid domain"}
	}
	if blockListID == "" {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "block list not configured (set BLOCK_LIST_ID)"}
	}
	if !blockListRE.MatchString(blockListID) {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "invalid block list id"}
	}
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "internal error"}
	}

	// No success predicate: the success shape for make_patch_request is
	// unobserved here, so CallToolChecked's fail-closed branch fires on every
	// call. Only a genuine transport error is treated as "rejected" below —
	// everything else falls through to the read-back, which is the actual
	// source of truth.
	detail, err := s.Mcp.CallToolChecked(ctx, "infoblox-portal_make_patch_request", map[string]any{
		"task_description": "Block domain " + domain,
		"service_name":     "Atcfw",
		"endpoint":         "/named_lists/" + blockListID,
		"body": map[string]any{"items_described": []map[string]any{
			{"item": domain, "description": "Blocked via NOC dashboard"}}},
	}, nil)
	if isMcpTransportError(err) {
		return map[string]any{
			"ok": false, "outcome": "rejected", "domain": domain, "list": blockListID,
			"error": "block request rejected: " + err.Error(), "detail": detail,
		}
	}

	return s.verifyOutcome(blockListID, domain, true, detail)
}

// UnblockDomain is unblock_domain (server.py:4592 / _unblock_domain_async 4577).
func (s *Service) UnblockDomain(ctx context.Context, domain, blockListID string) map[string]any {
	if !isFQDN(domain) {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "invalid domain"}
	}
	if blockListID == "" || !blockListRE.MatchString(blockListID) {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "block list not configured (set BLOCK_LIST_ID)"}
	}
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"ok": false, "outcome": "invalid", "error": "internal error"}
	}

	// See BlockDomain: no success predicate, same rationale.
	detail, err := s.Mcp.CallToolChecked(ctx, "infoblox-portal_make_delete_request", map[string]any{
		"task_description": "Unblock domain " + domain,
		"service_name":     "Atcfw",
		"endpoint":         "/named_lists/" + blockListID + "/items",
		"body":             map[string]any{"items": []any{domain}},
	}, nil)
	if isMcpTransportError(err) {
		return map[string]any{
			"ok": false, "outcome": "rejected", "domain": domain, "list": blockListID,
			"error": "unblock request rejected: " + err.Error(), "detail": detail,
		}
	}

	return s.verifyOutcome(blockListID, domain, false, detail)
}
