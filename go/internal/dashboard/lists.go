package dashboard

// Site lists: put a list of domains into a security policy (owner,
// 2026-11-12: "pull from info ranks push to a policy but dont lock me in to log
// block allow etc give me all the options and upload a csv for the same thing").
//
// The domains come from Infoblox's InfoRank list, a CSV or pasted text; this
// file does not care which. They go into a custom list (a new one, or added to
// an existing one, never replacing what it holds), and the list goes into one
// policy as a rule with any of the six actions, at the position chosen.
//
// Safety, in order:
//   - The preview reads the list and the policy and says exactly what changes,
//     including the policy's whole rule order before and after, and every other
//     policy already using the list (adding domains changes what those do too).
//   - The preview returns a fingerprint of the policy's rules. Apply refuses if
//     the rules no longer match it, so the policy written is the one previewed.
//   - A policy that already uses the list with a DIFFERENT action is refused in
//     the preview, before anything is written. With the SAME action only the
//     list changes, and the preview says so.
//   - A new list's name is checked free in the preview and again before it is
//     created, so a retry after a lost reply cannot make a second list.
//   - After the policy write, the policy is read back and every rule it had
//     before must still be there in the same order. Anything else is reported.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ListActions are the six rule actions a policy accepts for a custom list, in
// the words the page shows.
var ListActions = map[string]string{
	"action_allow":          "Allow",
	"action_block":          "Block",
	"action_block_nolog":    "Block without logging",
	"action_log":            "Log only",
	"action_redirect":       "Redirect",
	"action_redirect_nolog": "Redirect without logging",
}

const (
	// MaxListDomains is the most domains one request may carry: the size of
	// Infoblox's InfoRank list.
	MaxListDomains = 50000
	// listChunk is how many items go in one list write, so a large list is
	// not one enormous request.
	listChunk = 1000
	// inforankTTL: Infoblox refreshes the list daily.
	inforankTTL = 24 * time.Hour
)

const atcfw = "/api/atcfw/v1"

// InfoRankTop returns the first n domains of Infoblox's InfoRank list (most
// popular first) and the date Infoblox produced it.
func (s *Service) InfoRankTop(n int) (map[string]any, error) {
	if n < 1 || n > MaxListDomains {
		return nil, fmt.Errorf("top must be between 1 and %d", MaxListDomains)
	}
	v, err := s.Cache.DoTTL("inforank:set", inforankTTL, func() (any, error) {
		body, status, err := s.Rest.GetEx("/tide/api/data/set/inforank", nil)
		if err != nil {
			return nil, err
		}
		if status != 200 {
			return nil, fmt.Errorf("InfoRank list: http %d", status)
		}
		m := asMap(body)
		sites := asSlice(m["site"])
		if len(sites) == 0 {
			return nil, fmt.Errorf("InfoRank list came back empty")
		}
		domains := make([]string, 0, len(sites))
		for _, x := range sites {
			if d := canonDomain(fmt.Sprint(asMap(x)["domain"])); isFQDN(d) {
				domains = append(domains, d)
			}
		}
		return map[string]any{"date": m["download_date"], "domains": domains}, nil
	})
	if err != nil {
		return nil, err
	}
	all := asMap(v)
	domains, _ := all["domains"].([]string)
	if n > len(domains) {
		n = len(domains)
	}
	return map[string]any{"date": all["date"], "total": len(domains), "domains": domains[:n]}, nil
}

// ListTargets is what the page offers to pick from: custom lists, policies
// (with their rules, so the position can be shown) and custom redirect pages.
func (s *Service) ListTargets() (map[string]any, error) {
	lists, err := s.Rest.GetStrict(atcfw+"/named_lists", map[string]string{
		"_filter": `type=="custom_list"`, "_fields": "id,name,item_count,policies", "_limit": "1000"})
	if err != nil {
		return nil, err
	}
	policies, err := s.Rest.GetStrict(atcfw+"/security_policies", map[string]string{
		"_fields": "id,name,rules,is_default", "_limit": "1000"})
	if err != nil {
		return nil, err
	}
	redirects, err := s.Rest.GetStrict(atcfw+"/custom_redirects", map[string]string{"_fields": "name", "_limit": "1000"})
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, r := range redirects {
		if n := fmt.Sprint(asMap(r)["name"]); n != "" {
			names = append(names, n)
		}
	}
	return map[string]any{"lists": lists, "policies": policies, "redirects": names}, nil
}

// ListPlan is one request to put domains into a list and the list into a policy.
type ListPlan struct {
	Domains      []string
	ListID       int    // an existing custom list, or 0 for a new one
	ListName     string // the new list's name when ListID is 0
	PolicyID     int
	Action       string
	RedirectName string
	Position     int // where the rule goes: 0 is the top, len(rules) the bottom
	Fingerprint  string
	Dry          bool
	// RiskyOK are sites the threat check flagged that the owner ticked to add
	// anyway; UncheckedOK adds sites the check could not look up.
	RiskyOK     []string
	UncheckedOK bool
	// WantSites puts every site that will be added in the result as
	// "to_add", for the daily sync, which records them.
	WantSites bool
	// checked is what the threat check found, set by screen, so the
	// fingerprint covers it.
	checked string
}

// MaxCustomLists is Infoblox's limit on custom lists in one tenant. Seen live
// on 2026-11-13: "List limit 100 is exceeded for the list type 'custom_list'".
const MaxCustomLists = 100

// ParseListPlan reads a request body. Errors are for the person, not a log.
func ParseListPlan(b map[string]any) (ListPlan, error) {
	p := ListPlan{Action: strings.TrimSpace(fmt.Sprint(b["action"]))}
	if _, ok := ListActions[p.Action]; !ok {
		return p, fmt.Errorf("pick what the policy does with the list")
	}
	raw, ok := b["domains"].([]any)
	if !ok || len(raw) == 0 {
		return p, fmt.Errorf("there are no domains to add")
	}
	if len(raw) > MaxListDomains {
		return p, fmt.Errorf("at most %d domains at a time", MaxListDomains)
	}
	seen := map[string]bool{}
	var bad []string
	for _, v := range raw {
		s, _ := v.(string)
		d := canonDomain(s)
		if !isFQDN(d) {
			if len(bad) < 10 {
				bad = append(bad, fmt.Sprintf("%q", s))
			}
			continue
		}
		if !seen[d] {
			seen[d] = true
			p.Domains = append(p.Domains, d)
		}
	}
	if len(bad) > 0 {
		return p, fmt.Errorf("these are not domain names: %s", strings.Join(bad, ", "))
	}
	list := asMap(b["list"])
	if id, ok := intOf(list["id"]); ok && id > 0 {
		p.ListID = id
	} else {
		p.ListName = strings.TrimSpace(fmt.Sprint(list["name"]))
		if list["name"] == nil || p.ListName == "" || len(p.ListName) > 256 {
			return p, fmt.Errorf("pick a list, or name the new one")
		}
	}
	id, ok := intOf(b["policy_id"])
	if !ok || id <= 0 {
		return p, fmt.Errorf("pick a policy")
	}
	p.PolicyID = id
	pos, ok := intOf(b["position"])
	if !ok || pos < 0 {
		return p, fmt.Errorf("pick where the rule goes")
	}
	p.Position = pos
	if strings.HasPrefix(p.Action, "action_redirect") && b["redirect_name"] != nil {
		p.RedirectName = strings.TrimSpace(fmt.Sprint(b["redirect_name"]))
	}
	p.Fingerprint = strings.TrimSpace(fmt.Sprint(b["fingerprint"]))
	if b["fingerprint"] == nil {
		p.Fingerprint = ""
	}
	p.Dry = b["dry"] != false
	for _, v := range asSlice(b["risky_ok"]) {
		if d := canonDomain(fmt.Sprint(v)); d != "" {
			p.RiskyOK = append(p.RiskyOK, d)
		}
	}
	p.UncheckedOK = b["unchecked_ok"] == true
	return p, nil
}

func intOf(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	case int:
		return n, true
	case string:
		i, err := strconv.Atoi(strings.TrimSpace(n))
		return i, err == nil
	}
	return 0, false
}

// ruleView is a rule the way the preview shows it.
func ruleView(r map[string]any) map[string]any {
	return map[string]any{"type": r["type"], "data": r["data"], "action": r["action"]}
}

// fingerprint identifies a policy's rules exactly, in order, together with
// what was asked for, so Apply writes only what the preview showed: different
// domains, list, action or position after the preview is refused too.
func fingerprint(rules []any, p ListPlan) string {
	raw, _ := json.Marshal([]any{rules, p.PolicyID, p.Domains, p.ListID, p.ListName, p.Action, p.RedirectName, p.Position, p.checked})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

// readPolicy gets one policy as the object PUT will send back.
func (s *Service) readPolicy(id int) (map[string]any, int, error) {
	body, status, err := s.Rest.GetEx(fmt.Sprintf("%s/security_policies/%d", atcfw, id), nil)
	if err != nil || status != 200 {
		return nil, status, fmt.Errorf("could not read the policy (%s)", httpWord(status))
	}
	pol := asMap(asMap(body)["results"])
	if len(pol) == 0 {
		return nil, 502, fmt.Errorf("the policy came back empty")
	}
	return pol, 200, nil
}

// readList gets one custom list with its items.
func (s *Service) readList(id int) (map[string]any, int, error) {
	body, status, err := s.Rest.GetEx(fmt.Sprintf("%s/named_lists/%d", atcfw, id), nil)
	if err != nil || status != 200 {
		return nil, status, fmt.Errorf("could not read the list (%s)", httpWord(status))
	}
	l := asMap(asMap(body)["results"])
	if len(l) == 0 {
		return nil, 502, fmt.Errorf("the list came back empty")
	}
	return l, 200, nil
}

// listByName finds a custom list by its exact name; nil when there is none.
func (s *Service) listByName(name string) (map[string]any, int, error) {
	// Infoblox refuses name as a filter field on named lists ("Invalid filter
	// field: name"), so read them all, every type, and match here. A name is
	// taken whatever type the list holding it is.
	rows, err := s.Rest.GetStrict(atcfw+"/named_lists", map[string]string{
		"_fields": "id,name,type,policies", "_limit": "1000"})
	if err != nil {
		return nil, 0, err
	}
	var found map[string]any
	custom := 0
	for _, r := range rows {
		m := asMap(r)
		if fmt.Sprint(m["type"]) == "custom_list" {
			custom++
		}
		if found == nil && fmt.Sprint(m["name"]) == name {
			found = m
		}
	}
	return found, custom, nil
}

func httpWord(status int) string {
	if status == 0 {
		return "no answer"
	}
	return fmt.Sprintf("HTTP %d", status)
}

func itemSet(l map[string]any) map[string]bool {
	have := map[string]bool{}
	for _, it := range asSlice(l["items"]) {
		if s, ok := it.(string); ok {
			have[canonDomain(s)] = true
		}
	}
	return have
}

// planned is what the preview works out and Apply re-checks.
type planned struct {
	policy    map[string]any
	rules     []any
	listName  string
	list      map[string]any // nil for a new list
	toAdd     []string
	already   int
	ruleAt    int // index of an existing rule for this list, -1 when none
	needsRule bool
}

// plan reads the tenant and works out the change. A non-zero status means it
// cannot go ahead, and the error says why in plain words.
func (s *Service) plan(p ListPlan) (*planned, int, error) {
	pol, st, err := s.readPolicy(p.PolicyID)
	if err != nil {
		return nil, st, err
	}
	pl := &planned{policy: pol, rules: asSlice(pol["rules"]), ruleAt: -1}

	if p.ListID > 0 {
		l, st, err := s.readList(p.ListID)
		if err != nil {
			return nil, st, err
		}
		if fmt.Sprint(l["type"]) != "custom_list" {
			return nil, 400, fmt.Errorf("that list is not a custom list, so it cannot be changed here")
		}
		pl.list, pl.listName = l, fmt.Sprint(l["name"])
	} else {
		existing, custom, err := s.listByName(p.ListName)
		if err != nil {
			return nil, 502, fmt.Errorf("could not check whether the list name is free")
		}
		if existing != nil {
			return nil, 409, fmt.Errorf("a list called %q already exists. Pick it under Add to a list I have", p.ListName)
		}
		if custom >= MaxCustomLists {
			return nil, 409, fmt.Errorf("this tenant already has %d site lists, the most Infoblox allows. Add to a list you have, or delete one you no longer need", MaxCustomLists)
		}
		pl.listName = p.ListName
	}

	have := map[string]bool{}
	if pl.list != nil {
		have = itemSet(pl.list)
	}
	for _, d := range p.Domains {
		if have[d] {
			pl.already++
		} else {
			pl.toAdd = append(pl.toAdd, d)
		}
	}

	for i, r := range pl.rules {
		rm := asMap(r)
		if fmt.Sprint(rm["type"]) == "custom_list" && fmt.Sprint(rm["data"]) == pl.listName {
			pl.ruleAt = i
			if fmt.Sprint(rm["action"]) != p.Action {
				return nil, 409, fmt.Errorf("this policy already uses %q as %s (rule %d). Change that rule in Infoblox, or pick another list",
					pl.listName, ListActions[fmt.Sprint(rm["action"])], i+1)
			}
		}
	}
	pl.needsRule = pl.ruleAt < 0
	if pl.needsRule && p.Position > len(pl.rules) {
		return nil, 400, fmt.Errorf("the policy has %d rules; the new one can go from 1 to %d", len(pl.rules), len(pl.rules)+1)
	}
	return pl, 0, nil
}

// screen runs the threat check on the sites about to be added, before the
// fingerprint, so Apply adds exactly what the preview showed and refuses if
// the check came out differently. A flagged site, or one the check could not
// look up, is left out unless the owner said to add it.
func (s *Service) screen(pl *planned, p *ListPlan) map[string]any {
	risky, unchecked, reason := s.CheckSites(pl.toAdd)
	found, _ := json.Marshal([]any{risky, unchecked})
	p.checked = string(found)
	ok := map[string]bool{}
	for _, d := range p.RiskyOK {
		ok[d] = true
	}
	out := map[string]bool{}
	flagged := make([]map[string]any, 0, len(risky))
	for _, t := range risky {
		flagged = append(flagged, map[string]any{"domain": t.Domain, "class": t.Class, "property": t.Property, "level": t.Level, "added": ok[t.Domain]})
		if !ok[t.Domain] {
			out[t.Domain] = true
		}
	}
	if !p.UncheckedOK {
		for _, d := range unchecked {
			out[d] = true
		}
	}
	if len(out) > 0 {
		keep := func(xs []string) []string {
			k := make([]string, 0, len(xs))
			for _, x := range xs {
				if !out[x] {
					k = append(k, x)
				}
			}
			return k
		}
		pl.toAdd, p.Domains = keep(pl.toAdd), keep(p.Domains)
	}
	return map[string]any{"checked": len(pl.toAdd) + len(out) - len(unchecked), "risky": flagged,
		"unchecked": len(unchecked), "unchecked_added": p.UncheckedOK && len(unchecked) > 0, "reason": reason, "left_out": len(out)}
}

func (pl *planned) after(p ListPlan) []any {
	if !pl.needsRule {
		return pl.rules
	}
	rule := map[string]any{"type": "custom_list", "data": pl.listName, "action": p.Action,
		"description": "Added by Bloxsmith"}
	if strings.HasPrefix(p.Action, "action_redirect") {
		rule["redirect_name"] = p.RedirectName
	}
	out := make([]any, 0, len(pl.rules)+1)
	out = append(out, pl.rules[:p.Position]...)
	out = append(out, rule)
	return append(out, pl.rules[p.Position:]...)
}

func views(rules []any) []any {
	out := make([]any, 0, len(rules))
	for _, r := range rules {
		out = append(out, ruleView(asMap(r)))
	}
	return out
}

// ApplyList previews (Dry) or makes the change. The result always has "ok"
// and, for a live run, "outcome": verified, partial, unverified or unknown.
func (s *Service) ApplyList(p ListPlan) (map[string]any, int) {
	pl, st, err := s.plan(p)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, st
	}
	threats := s.screen(pl, &p)
	fp := fingerprint(pl.rules, p)
	newList := pl.list == nil
	var alsoUsedBy []any
	if !newList {
		for _, name := range asSlice(pl.list["policies"]) {
			if fmt.Sprint(name) != fmt.Sprint(pl.policy["name"]) {
				alsoUsedBy = append(alsoUsedBy, name)
			}
		}
	}
	sample := pl.toAdd
	if len(sample) > 50 {
		sample = sample[:50]
	}
	summary := map[string]any{
		"list":    map[string]any{"name": pl.listName, "new": newList, "will_add": len(pl.toAdd), "already_there": pl.already, "also_used_by": alsoUsedBy},
		"policy":  map[string]any{"id": p.PolicyID, "name": pl.policy["name"], "adds_rule": pl.needsRule, "existing_rule": pl.ruleAt + 1, "before": views(pl.rules), "after": views(pl.after(p))},
		"sample":  sample,
		"threats": threats,
	}
	if p.WantSites {
		summary["to_add"] = pl.toAdd
	}
	if p.Dry {
		summary["ok"], summary["dry_run"], summary["fingerprint"] = true, true, fp
		return summary, 200
	}

	if p.Fingerprint == "" || p.Fingerprint != fp {
		return map[string]any{"ok": false, "error": "the policy changed since the preview. Preview again"}, 409
	}
	if len(pl.toAdd) == 0 && !pl.needsRule {
		summary["ok"], summary["outcome"], summary["nothing_to_do"] = true, "verified", true
		return summary, 200
	}

	// 1. The list.
	listID := 0
	if pl.list != nil {
		listID, _ = intOf(pl.list["id"])
	}
	steps := map[string]any{}
	summary["steps"] = steps
	chunks := chunk(pl.toAdd, listChunk)
	firstN := 0
	if newList {
		first := []string{}
		if len(chunks) > 0 {
			first, chunks = chunks[0], chunks[1:]
		}
		firstN = len(first)
		resp, st, _ := s.Rest.Write("POST", atcfw+"/named_lists", map[string]any{
			"name": pl.listName, "type": "custom_list", "description": "Made by Bloxsmith",
			"items_described": described(first)}, nil)
		made := asMap(asMap(resp)["results"])
		id, ok := intOf(made["id"])
		switch {
		case st == 0 || st >= 500 || ((st == 200 || st == 201) && !ok):
			steps["list"] = map[string]any{"ok": false, "status": st}
			summary["ok"], summary["outcome"] = false, "unknown"
			summary["error"] = fmt.Sprintf("Infoblox did not confirm the new list (%s). It may exist: look for %q before trying again", httpWord(st), pl.listName)
			return summary, 502
		case st != 200 && st != 201:
			summary["ok"], summary["outcome"] = false, "rejected"
			summary["error"] = fmt.Sprintf("Infoblox refused the new list (%s). Nothing was changed", httpWord(st))
			summary["detail"] = resp
			return summary, st
		}
		listID = id
	}
	summary["list"].(map[string]any)["id"] = listID
	for i, c := range chunks {
		resp, st, _ := s.Rest.Write("PATCH", fmt.Sprintf("%s/named_lists/%d/items", atcfw, listID),
			map[string]any{"inserted_items_described": described(c)}, nil)
		if st < 200 || st > 299 {
			done := firstN + i*listChunk
			steps["list"] = map[string]any{"ok": false, "status": st, "added_before_failure": done}
			summary["ok"], summary["outcome"], summary["detail"] = false, "partial", resp
			if done == 0 {
				summary["outcome"] = "rejected"
			}
			summary["error"] = fmt.Sprintf("Infoblox stopped taking domains (%s) after about %d of %d. The policy was not changed. Preview again to add the rest",
				httpWord(st), done, len(pl.toAdd))
			return summary, 502
		}
	}
	l, _, err := s.readList(listID)
	missing := len(pl.toAdd)
	if err == nil {
		have := itemSet(l)
		missing = 0
		for _, d := range pl.toAdd {
			if !have[d] {
				missing++
			}
		}
	}
	steps["list"] = map[string]any{"ok": missing == 0, "id": listID, "added": len(pl.toAdd) - missing, "missing": missing}

	// 2. The policy.
	if !pl.needsRule {
		summary["ok"] = missing == 0
		summary["outcome"] = map[bool]string{true: "verified", false: "unverified"}[missing == 0]
		return summary, 200
	}
	pol, st, err := s.readPolicy(p.PolicyID)
	if err != nil || fingerprint(asSlice(pol["rules"]), p) != fp {
		steps["policy"] = map[string]any{"ok": false}
		summary["ok"], summary["outcome"] = false, "partial"
		summary["error"] = "the list is done, but the policy changed while the list was being filled, so it was left alone. Preview again to add the rule"
		return summary, 409
	}
	want := pl.after(p)
	pol["rules"] = want
	resp, st, _ := s.Rest.Write("PUT", fmt.Sprintf("%s/security_policies/%d", atcfw, p.PolicyID), pol, nil)
	if st < 200 || st > 299 {
		steps["policy"] = map[string]any{"ok": false, "status": st, "detail": resp}
		summary["ok"], summary["outcome"] = false, "partial"
		if st == 0 || st >= 500 {
			summary["outcome"] = "unknown"
		}
		summary["error"] = fmt.Sprintf("the list is done, but the policy was not confirmed (%s). Check the policy in Infoblox before trying again", httpWord(st))
		return summary, 502
	}
	got, _, err := s.readPolicy(p.PolicyID)
	if err != nil {
		steps["policy"] = map[string]any{"ok": true, "checked": false}
		summary["ok"], summary["outcome"] = false, "unverified"
		summary["error"] = "Infoblox accepted the change, but the policy could not be read back to check it. Look at it in Infoblox"
		return summary, 200
	}
	lost := lostRules(pl.rules, asSlice(got["rules"]))
	placed := ruleIndex(asSlice(got["rules"]), pl.listName, p.Action)
	steps["policy"] = map[string]any{"ok": len(lost) == 0 && placed >= 0, "position": placed + 1, "lost": lost}
	switch {
	case len(lost) > 0:
		summary["ok"], summary["outcome"] = false, "unverified"
		summary["error"] = fmt.Sprintf("the rule was added, but %d rule(s) the policy had before are no longer there. Check the policy in Infoblox now", len(lost))
		return summary, 502
	case placed < 0 || missing > 0:
		summary["ok"], summary["outcome"] = false, "unverified"
		summary["error"] = "Infoblox accepted the change, but reading it back did not show all of it yet. Refresh in a minute before trying again"
		return summary, 200
	}
	summary["ok"], summary["outcome"] = true, "verified"
	return summary, 200
}

func chunk(xs []string, n int) [][]string {
	var out [][]string
	for len(xs) > n {
		out = append(out, xs[:n])
		xs = xs[n:]
	}
	if len(xs) > 0 {
		out = append(out, xs)
	}
	return out
}

func described(ds []string) []any {
	out := make([]any, 0, len(ds))
	for _, d := range ds {
		out = append(out, map[string]any{"item": d, "description": "Added by Bloxsmith"})
	}
	return out
}

// lostRules names each rule from before that is missing from after, in order.
func lostRules(before, after []any) []any {
	key := func(r any) string {
		m := asMap(r)
		return fmt.Sprint(m["type"], "\x00", m["data"], "\x00", m["action"])
	}
	j := 0
	var lost []any
	for _, b := range before {
		k, start, found := key(b), j, false
		for j < len(after) {
			j++
			if key(after[j-1]) == k {
				found = true
				break
			}
		}
		if !found {
			lost = append(lost, ruleView(asMap(b)))
			j = start
		}
	}
	return lost
}

func ruleIndex(rules []any, list, action string) int {
	for i, r := range rules {
		m := asMap(r)
		if fmt.Sprint(m["type"]) == "custom_list" && fmt.Sprint(m["data"]) == list && fmt.Sprint(m["action"]) == action {
			return i
		}
	}
	return -1
}
