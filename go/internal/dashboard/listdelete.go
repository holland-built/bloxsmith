package dashboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// Deleting a custom list or one policy rule, for the Made with Bloxsmith page
// (server/made.go). The page previews first and deletes only what the preview
// showed; these functions read and write Infoblox, the page decides.

// ListState reads a custom list before a delete: its name, the policies that
// use it, and ver, a short hash of what is in it, so a delete can tell the
// list was edited since the preview. status is Infoblox's (404 when gone).
func (s *Service) ListState(id int) (name string, usedBy []string, ver string, status int, err error) {
	l, st, err := s.readList(id)
	if err != nil {
		return "", nil, "", st, err
	}
	for _, p := range asSlice(l["policies"]) {
		usedBy = append(usedBy, fmt.Sprint(p))
	}
	return fmt.Sprint(l["name"]), usedBy, listVer(l), 200, nil
}

// listVer is a short hash of what is in a list, so a delete can tell the list
// was edited since the preview.
func listVer(l map[string]any) string {
	b, _ := json.Marshal([]any{l["items"], l["items_described"]})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// DeleteList deletes one custom list by id. A list that is already gone counts
// as deleted.
func (s *Service) DeleteList(id int) (gone bool, status int, err error) {
	resp, st, _ := s.Rest.Write("DELETE", fmt.Sprintf("%s/named_lists/%d", atcfw, id), nil, nil)
	switch {
	case st == 404:
		return true, 200, nil
	case st < 200 || st > 299:
		return false, st, fmt.Errorf("Infoblox refused the delete (%s): %v", httpWord(st), resp)
	}
	return false, 200, nil
}

// rulesFingerprint is a short hash of a policy's rules, so a delete can tell
// whether the policy changed since its preview.
func rulesFingerprint(rules []any) string {
	raw, _ := json.Marshal(rules)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

// ruleMatches counts the rules that use list with action. A rule has no id of
// its own, so these two fields are how it is found; more than one match is
// refused rather than guessed.
func ruleMatches(rules []any, list, action string) int {
	n := 0
	for _, r := range rules {
		m := asMap(r)
		if fmt.Sprint(m["type"]) == "custom_list" && fmt.Sprint(m["data"]) == list && fmt.Sprint(m["action"]) == action {
			n++
		}
	}
	return n
}

// RuleState reads a policy before removing one rule: the policy's name, how
// many rules match, and the fingerprint of its rules.
func (s *Service) RuleState(policyID int, list, action string) (policy string, matches int, fp string, status int, err error) {
	pol, st, err := s.readPolicy(policyID)
	if err != nil {
		return "", 0, "", st, err
	}
	rules := asSlice(pol["rules"])
	return fmt.Sprint(pol["name"]), ruleMatches(rules, list, action), rulesFingerprint(rules), 200, nil
}

// RemoveRule drops the one rule that uses list with action, only if the
// policy's rules are still exactly what the preview saw (fp). The save sends
// the policy's ETag as If-Match, so if someone changes the policy between this
// read and the save, Infoblox answers 412 and nothing is saved. Infoblox sends
// an ETag on policies (seen 2026-11-13); whether its PUT honours If-Match was
// not testable with a read-only key, so the read-back check stays as well.
func (s *Service) RemoveRule(policyID int, list, action, fp string) (map[string]any, int) {
	body, st, etag, _ := s.Rest.GetETag(fmt.Sprintf("%s/security_policies/%d", atcfw, policyID), nil)
	pol := asMap(asMap(body)["results"])
	if st != 200 || len(pol) == 0 {
		return map[string]any{"ok": false, "error": fmt.Sprintf("could not read the policy (%s)", httpWord(st))}, statusOr(st)
	}
	if etag == "" {
		// Without it the save could land over someone else's change unseen.
		return map[string]any{"ok": false, "error": "Infoblox did not say which version of the policy this is, so Bloxsmith will not save over it"}, 502
	}
	rules := asSlice(pol["rules"])
	if rulesFingerprint(rules) != fp {
		return map[string]any{"ok": false, "error": "the policy changed since the preview. Preview again"}, 409
	}
	if ruleMatches(rules, list, action) != 1 {
		return map[string]any{"ok": false, "error": "the policy no longer has exactly one such rule. Preview again"}, 409
	}
	keep := make([]any, 0, len(rules)-1)
	for _, r := range rules {
		m := asMap(r)
		if fmt.Sprint(m["type"]) == "custom_list" && fmt.Sprint(m["data"]) == list && fmt.Sprint(m["action"]) == action {
			continue
		}
		keep = append(keep, r)
	}
	pol["rules"] = keep
	resp, st, _ := s.Rest.WriteIfMatch("PUT", fmt.Sprintf("%s/security_policies/%d", atcfw, policyID), pol, nil, etag)
	if st == 412 {
		return map[string]any{"ok": false, "error": "the policy changed while Bloxsmith was saving, so nothing was changed. Preview again"}, 409
	}
	if st < 200 || st > 299 {
		return map[string]any{"ok": false, "detail": resp,
			"error": fmt.Sprintf("Infoblox did not take the change (%s). Check the policy in Infoblox before trying again", httpWord(st))}, 502
	}
	got, _, err := s.readPolicy(policyID)
	if err != nil {
		return map[string]any{"ok": false, "error": "Infoblox accepted the change, but the policy could not be read back to check it. Look at it in Infoblox"}, 200
	}
	after := asSlice(got["rules"])
	lost := lostRules(keep, after)
	switch {
	case len(lost) > 0:
		return map[string]any{"ok": false, "lost": lost,
			"error": fmt.Sprintf("the rule was removed, but %d other rule(s) are no longer there. Check the policy in Infoblox now", len(lost))}, 502
	case ruleMatches(after, list, action) > 0:
		return map[string]any{"ok": false, "error": "Infoblox accepted the change, but the rule still shows. Refresh in a minute and check"}, 200
	}
	return map[string]any{"ok": true}, 200
}

func statusOr(st int) int {
	if st == 0 {
		return 502
	}
	return st
}

// ListItems is one custom list with its sites, in the order Infoblox keeps
// them, for Site lists' "Sites in this list".
func (s *Service) ListItems(id int) (map[string]any, int, error) {
	l, st, err := s.readList(id)
	if err != nil {
		return nil, st, err
	}
	if fmt.Sprint(l["type"]) != "custom_list" {
		return nil, 400, fmt.Errorf("that list is not a custom list")
	}
	items := []string{}
	for _, it := range asSlice(l["items"]) {
		if x, ok := it.(string); ok {
			items = append(items, canonDomain(x))
		}
	}
	return map[string]any{"id": id, "name": l["name"], "items": items, "policies": asSlice(l["policies"])}, 200, nil
}

// ListItemState reads one site in a custom list before it is removed: the
// list's name, whether the site is in it, the policies using the list, and
// ver, the same hash of the list's contents ListState gives. status is
// Infoblox's (404 when the list is gone).
func (s *Service) ListItemState(id int, domain string) (name string, present bool, usedBy []string, ver string, status int, err error) {
	l, st, err := s.readList(id)
	if err != nil {
		return "", false, nil, "", st, err
	}
	for _, p := range asSlice(l["policies"]) {
		usedBy = append(usedBy, fmt.Sprint(p))
	}
	return fmt.Sprint(l["name"]), itemSet(l)[canonDomain(domain)], usedBy, listVer(l), 200, nil
}

// RemoveListItem takes one site out of a custom list and reads the list back
// to see that it went. A list that is already gone counts as done.
func (s *Service) RemoveListItem(id int, domain string) (map[string]any, int) {
	d := canonDomain(domain)
	resp, st, _ := s.Rest.Write("PATCH", fmt.Sprintf("%s/named_lists/%d/items", atcfw, id),
		map[string]any{"deleted_items_described": []any{map[string]any{"item": d}}}, nil)
	switch {
	case st == 404:
		return map[string]any{"ok": true, "already_gone": true}, 200
	case st < 200 || st > 299:
		return map[string]any{"ok": false, "error": fmt.Sprintf("Infoblox refused to remove the site (%s): %v", httpWord(st), resp)}, statusOr(st)
	}
	l, st, err := s.readList(id)
	if err != nil {
		return map[string]any{"ok": false, "error": "Infoblox took the change but the list could not be read back to check it: " + err.Error()}, 502
	}
	if itemSet(l)[d] {
		return map[string]any{"ok": false, "error": "Infoblox answered yes, but " + d + " is still in the list"}, 502
	}
	return map[string]any{"ok": true}, 200
}
