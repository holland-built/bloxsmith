package dashboard

import (
	"crypto/sha256"
	"encoding/hex"
	"log"
	"sort"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// This file holds Bloxsmith's one read from Axur, the brand-protection service
// the Infoblox portal links out to. Axur is a SEPARATE vendor with a separate
// credential: nothing here goes through the Infoblox REST proxy or the account
// switcher, and Service.Axur is a distinct *rest.Client for exactly that reason
// (see helpers.go).
//
// The credential comes from one of two places, resolved live on every call by
// the rest.Auth main.go builds: the vault's stored Axur key first, then
// AXUR_API_KEY from the environment. Vault-over-environment matches what
// LLMCreds already does for the AI key, and having one precedence rule in the
// app beats having two. The vault is a per-deployment store here, NOT a
// per-tenant one — an Axur key belongs to the installation, and an Infoblox
// account switch must never change which one is sent.
//
// The shape it returns matches the other threat-intel fetchers — a rows key
// plus "unavailable" / "not_entitled" on failure — so the Security tab renders
// a dead Axur feed the way it renders a dead TDLAD one, and never as "0".

// axurTicketTypesPath is Axur's "Ticket Incident Count by Type" operation. It
// answers the whole panel in one request: a count per ticket type over a date
// window. Appended whole to config.AxurBaseURL, whose gateway prefix
// (/gateway/1.0/api) is part of the base — rest.Client.url concatenates, it
// does not resolve a relative reference.
const axurTicketTypesPath = "/tickets-api/stats/incident/count/ticket-types"

// axurWindowDays is the reporting window. Axur REQUIRES from and to, and
// rejects a span over 90 days; 30 is the smallest window that still shows a
// trend rather than a quiet weekend, and leaves headroom under the cap.
const axurWindowDays = 30

// axurWindow returns the [from, to] pair as Axur's documented "YYYY-MM-DD",
// in UTC because the endpoint's timezone parameter defaults to UTC and passing
// local dates against a UTC-interpreted window silently shifts the whole range.
//
// now is a parameter, not time.Now(), so a test asserts the exact query string
// rather than approximating it.
func axurWindow(now time.Time) (from, to string) {
	end := now.UTC()
	return end.AddDate(0, 0, -axurWindowDays).Format("2006-01-02"), end.Format("2006-01-02")
}

// FetchAxurTickets reads Axur's incident count by ticket type for the last
// axurWindowDays.
//
// FOUR outcomes, deliberately distinguishable by the caller. The first two look
// alike from a distance and must never be collapsed, because they send an
// operator to opposite places:
//
//   - not configured — no credential from either source. configured:false and
//     no error wording; the panel says so and nothing is wrong.
//   - vault locked — a credential may well be stored, but the vault holding it
//     is shut, so this process cannot read it. Says "vault locked", NOT "not
//     configured", which would be a claim we have no basis for.
//   - failed — any transport, status or decode failure. "unavailable", plus
//     not_entitled on a 403, and NEVER an empty types list that a reader could
//     mistake for a clean zero.
//   - loaded — types is the per-type counts, possibly genuinely empty.
func (s *Service) FetchAxurTickets() map[string]any {
	base := map[string]any{"types": []any{}, "window_days": axurWindowDays}
	if s.Axur == nil {
		base["configured"] = false
		return base
	}
	// ONE resolution, used for both the decision and the request. Asking "is a
	// key configured?" and then letting the request resolve the slot a second
	// time is a race: a vault lock landing between the two sends an empty
	// Authorization upstream and turns "you have no key" into a 401 that reads
	// as "your key is wrong". See rest.Client.PinResolved.
	client, cred := s.Axur.PinResolved()
	if cred == "" {
		// Nothing resolved. Which of the two reasons it is decides what the
		// operator is told, and only the vault can say.
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

	from, to := axurWindow(time.Now())
	// The credential's FINGERPRINT is part of the cache key, not just the date
	// window. A cached response was fetched with whatever key was live at the
	// time; after a key change, a date-only key would keep serving it — which
	// for a multi-tenant vendor API means showing one Axur tenant's incident
	// counts under another tenant's credential. Changing the key now misses the
	// cache, and leaving it alone still hits. The fingerprint is a truncated
	// SHA-256 and never the secret itself: cache keys are logged.
	ck := cache.Key("axur_ticket_types", axurTicketTypesPath,
		map[string]string{"from": from, "to": to, "cred": axurCredFingerprint(cred)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	// GetPageStrict, not GetEx: GetEx hands back (nil, 200, nil) for a body it
	// could not use, which arrives here as zero ticket types and renders as a
	// calm "no incidents". That exact conflation was DEFECT 3 in the lookalikes
	// feed (threatintel.go). Every failure below is a failure.
	_, body, err := client.GetPageStrict(axurTicketTypesPath,
		map[string]string{"from": from, "to": to})
	if err != nil {
		log.Printf("axur: ticket-type counts fetch failed: %v", err)
		result := axurUnavailable(err)
		result["configured"] = true
		result["window_days"] = axurWindowDays
		result["from"] = from
		result["to"] = to
		// NOT cached. A failure is usually the thing an operator is actively
		// fixing — a wrong key, a lapsed entitlement, an outage — and caching it
		// means their correction appears not to work until the TTL expires. A
		// success is worth holding; a failure is worth retrying.
		return result
	}
	result := normAxurTickets(body)
	result["configured"] = true
	result["window_days"] = axurWindowDays
	result["from"] = from
	result["to"] = to
	s.Cache.SetGen(ck, result, g)
	return result
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
// is called out separately because "this tenant is not entitled to this Axur
// module" is a different message to an operator than "Axur is down", and a
// panel that says the wrong one sends someone to the wrong place.
//
// A 401 is folded into the generic outage wording ON PURPOSE with its own
// sentence: on Axur a 401 means the credential, not the entitlement, and the
// operator's next move is to check AXUR_API_KEY rather than their licence.
func axurUnavailable(err error) map[string]any {
	reason := "Axur service unavailable"
	notEntitled := false
	if ue, ok := err.(*rest.UpstreamError); ok {
		switch ue.Status {
		case 403:
			reason = "Axur incident counts not entitled"
			notEntitled = true
		case 401:
			reason = "Axur rejected the credential — check AXUR_API_KEY"
		}
	}
	return map[string]any{"types": []any{}, "unavailable": reason, "not_entitled": notEntitled}
}

// normAxurTickets shapes Axur's totalByTicketType array into the rows the panel
// renders: {type, count}, highest first, with a total.
//
// Axur returns every ticket type it knows about, most of them zero for any one
// tenant. Zero rows are dropped here rather than in the UI so the panel's row
// count means "kinds of incident you actually have".
func normAxurTickets(body map[string]any) map[string]any {
	types := []any{}
	total := 0
	for _, row := range asSlice(body["totalByTicketType"]) {
		m := asMap(row)
		name := getStr(m["type"])
		if name == "" {
			continue
		}
		// JSON numbers decode to float64; an int conversion is exact for the
		// counts this endpoint returns.
		count := 0
		if f, ok := m["totalOnPeriod"].(float64); ok {
			count = int(f)
		}
		if count == 0 {
			continue
		}
		total += count
		types = append(types, map[string]any{"type": name, "count": count})
	}
	// Highest count first, then by name, so the order is stable across polls
	// for two types that happen to tie.
	sort.SliceStable(types, func(i, j int) bool {
		a, b := asMap(types[i]), asMap(types[j])
		ai, _ := a["count"].(int)
		bi, _ := b["count"].(int)
		if ai != bi {
			return ai > bi
		}
		return getStr(a["type"]) < getStr(b["type"])
	})
	return map[string]any{"types": types, "total": total, "not_entitled": false}
}
