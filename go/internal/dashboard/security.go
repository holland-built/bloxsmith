package dashboard

import (
	"context"
	"regexp"
)

// This file ports the security-policy write engine (server.py:4554-4593):
// block_domain / unblock_domain. Both validate the domain against a strict FQDN
// regex and require an allowlisted BLOCK_LIST_ID (never a fuzzy name match),
// then patch/delete the named-list item via the MCP portal write tools. The
// route layer adds the X-Auth-Token gate + audit entry (server.py:6110/6127).

// blockListRE is _TABLE_RE (server.py:173): the block-list id must match before
// it is interpolated into the endpoint path.
var blockListRE = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,127}$`)

// BlockDomain is block_domain (server.py:4574 / _block_domain_async 4556).
func (s *Service) BlockDomain(ctx context.Context, domain, blockListID string) map[string]any {
	if !isFQDN(domain) {
		return map[string]any{"ok": false, "error": "invalid domain"}
	}
	if blockListID == "" {
		return map[string]any{"ok": false, "error": "block list not configured (set BLOCK_LIST_ID)"}
	}
	if !blockListRE.MatchString(blockListID) {
		return map[string]any{"ok": false, "error": "invalid block list id"}
	}
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"ok": false, "error": "internal error"}
	}
	_, err := s.Mcp.CallTool(ctx, "infoblox-portal_make_patch_request", map[string]any{
		"task_description": "Block domain " + domain,
		"service_name":     "Atcfw",
		"endpoint":         "/named_lists/" + blockListID,
		"body": map[string]any{"items_described": []map[string]any{
			{"item": domain, "description": "Blocked via NOC dashboard"}}},
	})
	if err != nil {
		return map[string]any{"ok": false, "error": "internal error"}
	}
	return map[string]any{"ok": true, "domain": domain, "list": blockListID}
}

// UnblockDomain is unblock_domain (server.py:4592 / _unblock_domain_async 4577).
func (s *Service) UnblockDomain(ctx context.Context, domain, blockListID string) map[string]any {
	if !isFQDN(domain) {
		return map[string]any{"ok": false, "error": "invalid domain"}
	}
	if blockListID == "" || !blockListRE.MatchString(blockListID) {
		return map[string]any{"ok": false, "error": "block list not configured (set BLOCK_LIST_ID)"}
	}
	if s.Mcp == nil || s.Mcp.Initialize(ctx) != nil {
		return map[string]any{"ok": false, "error": "internal error"}
	}
	_, err := s.Mcp.CallTool(ctx, "infoblox-portal_make_delete_request", map[string]any{
		"task_description": "Unblock domain " + domain,
		"service_name":     "Atcfw",
		"endpoint":         "/named_lists/" + blockListID + "/items",
		"body":             map[string]any{"items": []any{domain}},
	})
	if err != nil {
		return map[string]any{"ok": false, "error": "internal error"}
	}
	return map[string]any{"ok": true, "domain": domain, "list": blockListID}
}
