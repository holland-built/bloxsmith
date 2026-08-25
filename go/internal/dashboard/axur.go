package dashboard

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// This file holds Bloxsmith's read from Axur, the brand-protection and
// supply-chain vendor the Infoblox portal links out to. Axur is a SEPARATE
// vendor with a separate credential: nothing here goes through the Infoblox
// REST proxy or the account switcher, and Service.Axur is a distinct
// *rest.Client for exactly that reason (see helpers.go).
//
// The credential comes from one of two places, resolved live on every call by
// the rest.Auth main.go builds: the vault's stored Axur key first, then
// AXUR_API_KEY from the environment. The vault is a per-deployment store here,
// NOT a per-tenant one — an Axur key belongs to the installation, and an
// Infoblox account switch must never change which one is sent.
//
// WHAT IT READS, AND WHY THAT CHANGED. This first shipped against Axur's
// brand-abuse ticket counts and returned a correct, permanent zero: the account
// monitors ten SUPPLIERS under Supply Chain Intel and has no brand assets of
// its own beyond demo placeholders. A panel that can only ever say zero is
// worse than no panel, because zero reads as "all clear". It now reads the
// per-supplier security indicators, which is what this account actually
// produces.
const (
	// axurIndicatorsPath is Axur's "Get Indicators" operation, per vendor. The
	// customer key is a PATH segment, which is the whole reason
	// axurCustomerKey below has to exist.
	axurIndicatorsPath = "/vendor-monitor/customer-vendors-api/customer/%s/indicators"
	// The two ways to discover that customer key, in the order they are tried.
	axurAssetsPath    = "/assets-api/assets"
	axurCustomersPath = "/customers-api/customers"
	// axurHistoryPath is the one discovery route designed for an ORDINARY
	// requester: "history entries visible to the authenticated requester", no
	// account code in the path and no manager permission. Every entry carries a
	// required customerKey. It is tried first because the other two cannot
	// bootstrap themselves on this kind of account — /assets-api/assets answers
	// 400 "Invalid request parameter" without a customerKey it is supposed to
	// discover, and /customers-api/customers wants MSSP Partner Manager.
	axurHistoryPath = "/vendor-monitor/history/customer-vendor"

	// axurPageSize is the documented maximum ("It supports sizes up to 20").
	axurPageSize = 20
	// axurMaxPages bounds the walk at 200 suppliers. A supplier list is tens of
	// entries, not thousands; the bound exists so a paginating upstream that
	// never reports a short final page cannot spin here. Hitting it is LOGGED,
	// never silently truncated — a capped list rendered as a complete one is
	// exactly the failure this file is careful about everywhere else.
	axurMaxPages = 10
)

// FetchAxurVendors reads per-supplier security indicators from Axur.
//
// The outcomes are deliberately distinguishable, and the first three look alike
// from a distance while sending an operator to completely different places:
//
//   - not configured — no credential from either source. configured:false, no
//     error wording, nothing is wrong.
//   - vault locked — a credential may well be stored, but the vault is shut so
//     this process cannot read it. Says so; never "not configured".
//   - account code unknown — the credential works, but neither discovery route
//     produced exactly one customer key. Names the override. This CONFIGURATION
//     answer is only ever given when the discovery calls actually succeeded and
//     were unambiguous about having no single answer.
//   - failed — any transport, status or decode failure, discovery calls
//     included. "unavailable", plus not_entitled on a 403, and never an empty
//     list a reader could mistake for a clean zero.
//   - loaded — vendors, possibly genuinely empty, which the panel renders as
//     "no suppliers monitored" rather than as a reassuring zero.
func (s *Service) FetchAxurVendors() map[string]any {
	base := map[string]any{"vendors": []any{}}
	if s.Axur == nil {
		base["configured"] = false
		return base
	}
	// ONE resolution, used for the decision, the discovery calls and the fetch.
	// Asking "is a key configured?" and then letting each request resolve the
	// slot again is a race: a vault lock landing in between sends an empty
	// Authorization upstream, and "you have no key" comes back as a 401 that
	// reads as "your key is wrong". See rest.Client.PinResolved.
	client, cred := s.Axur.PinResolved()
	if cred == "" {
		if s.AxurLocked != nil && s.AxurLocked() {
			base["configured"] = true
			base["locked"] = true
			base["unavailable"] = "Vault locked — unlock to read Axur"
			base["not_entitled"] = false
			return base
		}
		base["configured"] = false
		return base
	}
	base["configured"] = true

	customer, degraded := s.axurCustomerKey(client, cred)
	if degraded != nil {
		// Discovery could not answer. `degraded` already carries the RIGHT
		// category: an outage stays an outage, a 403 stays an entitlement
		// problem, and only a clean-but-empty answer becomes the configuration
		// message. Collapsing them would tell someone to set a variable while
		// Axur was simply down.
		for k, v := range degraded {
			base[k] = v
		}
		return base
	}

	ck := cache.Key("axur_vendor_indicators", customer,
		map[string]string{"cred": axurCredFingerprint(cred)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	vendors, err := s.axurWalkIndicators(client, customer)
	if err != nil {
		log.Printf("axur: supplier indicators fetch failed: %v", err)
		result := axurUnavailable(err)
		result["configured"] = true
		// NOT cached. A failure is usually the thing an operator is actively
		// fixing — a wrong key, a lapsed entitlement, an outage — and caching it
		// makes their correction appear not to work until the TTL expires.
		return result
	}
	total := 0
	for _, v := range vendors {
		if n, ok := asMap(v)["findings"].(int); ok {
			total += n
		}
	}
	result := map[string]any{
		"configured":     true,
		"customer":       customer,
		"vendors":        vendors,
		"total_findings": total,
		"not_entitled":   false,
	}
	s.Cache.SetGen(ck, result, g)
	return result
}

// axurWalkIndicators pages through the indicator list and shapes it.
//
// It WALKS rather than reading page one alone: the panel claims worst-first
// ordering, and a worst-first ordering computed over an arbitrary first page is
// simply wrong the moment there are more suppliers than fit on it.
func (s *Service) axurWalkIndicators(client *rest.Client, customer string) ([]any, error) {
	// PathEscape, because the customer key lands in a URL PATH segment and can
	// arrive from an operator-set variable. Unescaped, a value containing a
	// slash would silently retarget the request at a different endpoint.
	path := fmt.Sprintf(axurIndicatorsPath, url.PathEscape(customer))
	var rows []any
	for page := 1; page <= axurMaxPages; page++ {
		_, body, err := client.GetPageStrict(path, map[string]string{
			"page": fmt.Sprint(page),
			"size": fmt.Sprint(axurPageSize),
		})
		if err != nil {
			return nil, err
		}
		// A response carrying no "data" key AT ALL is not an empty supplier
		// list. It is a shape this code does not understand, and calling it zero
		// is the exact conflation the rest of this file exists to avoid.
		raw, present := body["data"]
		if !present {
			return nil, fmt.Errorf("axur indicators: response had no data field")
		}
		batch := asSlice(raw)
		rows = append(rows, batch...)
		if len(batch) < axurPageSize {
			break
		}
		if page == axurMaxPages {
			log.Printf("axur: stopped at the %d-page cap with a full final page; the supplier list may be longer than %d entries",
				axurMaxPages, axurMaxPages*axurPageSize)
		}
	}
	return normAxurVendors(rows), nil
}

// normAxurVendors shapes the indicator rows into the panel's table.
//
// THE SCORE, SPELLED OUT, because "non-zero indicators" and "worst" each read
// two ways when every indicator carries both a primary and a secondary value:
//
//   - findings = how many indicator TYPES have a primary value above zero.
//     Primary alone: it is the headline metric Axur puts first, and counting a
//     type twice because its secondary is also set would inflate the number
//     against its own label.
//   - top = the indicator type with the highest primary value, ties broken by
//     type name ascending so the row does not flicker between polls.
//   - vendors sort by findings descending, then top value descending, then name
//     ascending. Three keys, so the order is total and stable.
func normAxurVendors(rows []any) []any {
	out := []any{}
	for _, r := range rows {
		m := asMap(r)
		name := getStr(m["name"])
		if name == "" {
			// A supplier with no name cannot be rendered or acted on. Skipping
			// is safe here in a way that skipping a COUNT would not be: the row
			// carries no finding of its own that would go missing with it.
			continue
		}
		findings := 0
		topType, topVal := "", 0
		for _, ind := range asSlice(m["indicators"]) {
			im := asMap(ind)
			t := getStr(im["type"])
			v := axurIndicatorValue(im["primary"])
			if v <= 0 {
				continue
			}
			findings++
			if v > topVal || (v == topVal && (topType == "" || t < topType)) {
				topType, topVal = t, v
			}
		}
		out = append(out, map[string]any{
			"name":      name,
			"asset_key": getStr(m["assetKey"]),
			"findings":  findings,
			"top_type":  topType,
			"top_value": topVal,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := asMap(out[i]), asMap(out[j])
		af, _ := a["findings"].(int)
		bf, _ := b["findings"].(int)
		if af != bf {
			return af > bf
		}
		av, _ := a["top_value"].(int)
		bv, _ := b["top_value"].(int)
		if av != bv {
			return av > bv
		}
		return getStr(a["name"]) < getStr(b["name"])
	})
	return out
}

// axurIndicatorValue reads {"value": n}. A missing or non-numeric value is 0
// and NOT an error: an indicator that reports nothing is a real state, unlike a
// whole response with no data field.
func axurIndicatorValue(v any) int {
	if f, ok := asMap(v)["value"].(float64); ok {
		return int(f)
	}
	return 0
}

// axurCustomerKey resolves the customer key for the indicators path, returning
// (key, nil) on success or ("", degradeShape) with the reason.
//
// The cache holds either the resolved key or the FAILURE. Caching the failure
// is deliberate and is not an accident of reuse: without it every dashboard
// refresh re-runs both discovery calls, turning a permission problem into a
// steady stream of 403s against a third party's API. The classification is
// preserved, so the cached answer is the same answer, only cheaper.
//
// The cache key carries the credential fingerprint, so a key discovered under
// one credential can never be used in the path while a different credential
// goes in the header — the mix a process-lifetime cache would have allowed the
// moment someone saved a new key on the Settings screen.
func (s *Service) axurCustomerKey(client *rest.Client, cred string) (string, map[string]any) {
	if s.AxurCustomer != "" {
		// An explicit operator answer outranks any guess this code could make.
		return s.AxurCustomer, nil
	}
	ck := cache.Key("axur_customer_key", "", map[string]string{"cred": axurCredFingerprint(cred)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		if res, isFailure := v.(map[string]any); isFailure {
			return "", res
		}
		if key, isKey := v.(string); isKey {
			return key, nil
		}
	}
	key, degraded := s.axurDiscoverCustomer(client)
	g := s.Cache.Gen()
	if degraded != nil {
		s.Cache.SetGen(ck, degraded, g)
		return "", degraded
	}
	s.Cache.SetGen(ck, key, g)
	return key, nil
}

// axurDiscoverCustomer runs the probes and reconciles them.
//
// THE CONTRACT, restated because it changed. Every probe that SUCCEEDS
// contributes the account codes it saw. A code is accepted only when every code
// observed across every successful probe is the same single value. Taking the
// first was the original plan and it is unsafe: on an MSSP login these
// endpoints list several customers, and picking one arbitrarily would put
// another company's tenant in the request path and render their suppliers on
// this dashboard.
//
// MIXED OUTCOMES, which the first version got wrong. When one probe fails and
// another succeeds but carries no code, the actionable answer is the
// configuration one — "set AXUR_CUSTOMER_KEY" — not the earlier failure. An
// operator can act on the first; the second only tells them something they
// cannot reach was unhappy. The failure is still LOGGED either way, at the
// point it is captured rather than at the point it wins, so the body that
// explains it never depends on which outcome came out on top.
func (s *Service) axurDiscoverCustomer(client *rest.Client) (string, map[string]any) {
	var firstErr error
	anySucceeded := false
	var seen []string
	for _, probe := range []struct {
		path   string
		field  string
		params map[string]string
		walk   bool
	}{
		// No parameters at all. Every one this endpoint takes is optional, and
		// each one sent is another chance at the "Invalid request parameter"
		// that made the assets probe useless here.
		{axurHistoryPath, "customerKey", nil, false},
		// Assets pages, so a multi-account credential cannot be mistaken for a
		// single-account one by a first page that happens to be uniform.
		// perPage 20, not 100. Axur answered 100 with a 400 and "Invalid request
		// parameter" — measured against the live account on 2026-08-25, not
		// inferred: its published example uses 20, and its sibling endpoints
		// document 20 as the maximum. The walk below covers the rest.
		{axurAssetsPath, "customerKey", map[string]string{"perPage": "20"}, true},
		// Customers documents NO query parameters. Sending page/perPage to an
		// endpoint that declares none is how a 400 gets invented.
		{axurCustomersPath, "key", nil, false},
	} {
		keys, err := s.axurProbe(client, probe.path, probe.field, probe.params, probe.walk)
		if err != nil {
			// Logged HERE, at capture, with the provider's own bounded and
			// redacted body. Whatever precedence wins below, the reason is on
			// the record.
			if ue, ok := err.(*rest.UpstreamError); ok {
				rest.LogUpstreamError(ue)
			} else {
				log.Printf("axur: probe %s failed: %v", probe.path, err)
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		anySucceeded = true
		seen = append(seen, keys...)
	}
	unique := uniqueStrings(seen)
	switch {
	case len(unique) == 1:
		return unique[0], nil
	case len(unique) > 1:
		log.Printf("axur: discovery saw %d distinct customer keys; refusing to guess", len(unique))
		return "", axurNeedsCustomerKey(fmt.Sprintf(
			"This Axur key can see %d accounts, so Bloxsmith cannot tell which one to read.", len(unique)))
	case anySucceeded:
		// A clean answer that simply carried no code. Actionable, and it beats
		// reporting a sibling probe's failure.
		return "", axurNeedsCustomerKey("Axur did not report an account code for this key.")
	}
	// EVERY probe failed. An outage or an entitlement problem, not a
	// configuration one, and it keeps its own category — telling an operator to
	// set a variable while Axur is down sends them the wrong way.
	degraded := axurUnavailable(firstErr)
	if r, ok := degraded["unavailable"].(string); ok {
		degraded["unavailable"] = "Could not look up the Axur account code. " + r +
			" Set AXUR_CUSTOMER_KEY to skip the lookup."
	}
	return "", degraded
}

// axurProbe reads one discovery endpoint and returns the account codes it
// carried.
//
// A 2xx whose body is not the SHAPE this probe expects is an error, not an
// empty result. Without that check an error envelope returned at HTTP 200 —
// which these APIs do — would count as "succeeded, carried no code" and be
// reported to the operator as a missing setting.
func (s *Service) axurProbe(client *rest.Client, path, field string, params map[string]string, walk bool) ([]string, error) {
	var out []string
	for page := 1; page <= axurMaxPages; page++ {
		p := map[string]string{}
		for k, v := range params {
			p[k] = v
		}
		if walk {
			p["page"] = fmt.Sprint(page)
		}
		rows, body, err := client.GetPageStrict(path, p)
		if err != nil {
			return nil, err
		}
		if body == nil && rows == nil {
			return nil, fmt.Errorf("axur %s: response was neither an object nor an array", path)
		}
		batch := axurRowsOf(rawBody(rows, body))
		if batch == nil {
			return nil, fmt.Errorf("axur %s: response carried no recognisable list", path)
		}
		out = append(out, collectField(rawBody(rows, body), field)...)
		if !walk || len(batch) == 0 {
			break
		}
		if page == axurMaxPages {
			log.Printf("axur: %s discovery stopped at the %d-page cap", path, axurMaxPages)
		}
	}
	return out, nil
}

// axurRowsOf finds the list inside a decoded response, whichever envelope name
// the endpoint uses. nil means "no list here", which callers treat as a shape
// failure rather than as an empty list.
func axurRowsOf(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case map[string]any:
		for _, envelope := range []string{"results", "items", "data", "assets", "customers"} {
			if nested, ok := t[envelope]; ok {
				if rows, ok := nested.([]any); ok {
					return rows
				}
			}
		}
	}
	return nil
}

// axurNeedsCustomerKey is the configuration degrade shape. It names the
// variable, because "could not determine the account" without the remedy leaves
// a reader with nowhere to go.
func axurNeedsCustomerKey(why string) map[string]any {
	return map[string]any{
		"vendors":      []any{},
		"unavailable":  why + " Set AXUR_CUSTOMER_KEY to the account code to fix this.",
		"needs_key":    true,
		"not_entitled": false,
	}
}

// collectField pulls every non-empty string value of `field` out of a decoded
// response, whether the rows are the top-level array or sit under one of the
// envelope names these APIs use.
func collectField(v any, field string) []string {
	var out []string
	switch t := v.(type) {
	case []any:
		for _, row := range t {
			out = append(out, collectField(row, field)...)
		}
	case map[string]any:
		// Two shapes, because Axur uses both. The asset and customer endpoints
		// carry the code as a bare string; the vendor-monitor history endpoint
		// wraps it as {"customerKey":{"value":"TAGG"}}. Reading only the first
		// shape made the history probe look like a response with no code in it.
		if s := getStr(t[field]); s != "" {
			out = append(out, s)
		} else if wrapped, ok := t[field].(map[string]any); ok {
			if s := getStr(wrapped["value"]); s != "" {
				out = append(out, s)
			}
		}
		for _, envelope := range []string{"results", "items", "data", "assets", "customers"} {
			if nested, ok := t[envelope]; ok {
				out = append(out, collectField(nested, field)...)
			}
		}
	}
	return out
}

// uniqueStrings de-duplicates while keeping first-seen order, so the "exactly
// one" test above counts DISTINCT keys rather than rows.
func uniqueStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// axurCredFingerprint reduces a credential to a short, non-reversible tag for
// the cache key. Truncated to 12 hex characters: long enough that two live keys
// colliding is not a thing that happens, short enough to keep the key readable,
// and it is a one-way hash so a logged cache key never carries the secret.
func axurCredFingerprint(cred string) string {
	sum := sha256.Sum256([]byte(cred))
	return hex.EncodeToString(sum[:])[:12]
}

// axurUnavailable is the degrade shape, mirroring lookalikeUnavailable: a 403
// is called out separately because "this account is not entitled to this Axur
// module" is a different message to an operator than "Axur is down", and a
// panel that says the wrong one sends someone to the wrong place.
//
// A 401 gets its own sentence: on Axur a 401 means the credential, not the
// entitlement, and the operator's next move is to check the key rather than
// their licence.
func axurUnavailable(err error) map[string]any {
	reason := "Axur service unavailable"
	notEntitled := false
	if ue, ok := err.(*rest.UpstreamError); ok {
		switch ue.Status {
		case 403:
			reason = "Axur supplier monitoring not entitled for this key"
			notEntitled = true
		case 401:
			reason = "Axur rejected the credential — check the key under Settings"
		default:
			// The status, in words, via the sanitized sentence rest already
			// owns. WHY IT IS NOT JUST "unavailable": that is what this said
			// first, and when the live account hit this path on 2026-08-25 the
			// panel gave a reader — and the person who wrote it — no way to tell
			// a 404 from a 500 from an unreachable host. Public() deliberately
			// omits path and body, so nothing about the request leaks.
			reason = "Axur service unavailable — " + ue.Public()
			// Plus Axur's OWN wording, when it is one of the recognised message
			// fields. This is the allowlist internal/server has always used for
			// the same job: recognised keys only, 200 characters, and no
			// fallback to the raw body when nothing matches. Without it the
			// status alone left a 400 undiagnosable — a status says the request
			// was refused, not which part of it was wrong.
			if msg, found := rest.UpstreamMessage(ue.Snippet); found {
				reason += " Axur said: " + msg
			}
		}
	}
	return map[string]any{"vendors": []any{}, "unavailable": reason, "not_entitled": notEntitled}
}
