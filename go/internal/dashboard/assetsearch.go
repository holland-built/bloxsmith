// Find a device by IP or MAC address.
//
// The cube behind the Assets list cannot do this: /api/csp/assets?q= with an IP
// fails upstream (docs/adr/0002). Infoblox's asset search API can, so a search
// box holding one IP or MAC is sent there instead, and anything else stays the
// name search in assets.go.
//
// FACTS MEASURED against the live tenant on 2026-11-17:
//
//   - POST /api/v1/assets/search {"sync":{"mode":"FULL"},"filter":"ip_addresses = '172.17.0.4'"}
//     answered 200 in about 1 s with 3 devices; "mac_addresses = '...'" works
//     too, in upper or lower case.
//   - IPv6 matches only in its short form: 2001:db8:a42:cafe:100::123 found a
//     device, 2001:DB8:A42:CAFE:100:0:0:123 found nothing. So every address is
//     rewritten in its standard short spelling before it is sent.
//   - A value that is not an address answers 400 INVALID_SYNTAX.
//   - The search returns only managed assets synced in the last 7 days
//     (uddi-mock's csp-api.service.ts:1023-1026 says the same), so "no hits"
//     means "not seen in the last 7 days", and the page says exactly that.
//   - A hit's id is the cube's cqid (checked on echo-master), so a row found
//     here opens the same detail panel as a row from the name search.
package dashboard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

const (
	assetSearchPath = "/api/v1/assets/search"
	// assetSearchWindowDays is the search API's own window, not a setting.
	assetSearchWindowDays = 7
	// assetSearchPageSize: one address rarely belongs to more than a handful of
	// devices (the busiest probe hit 3), so one page holds them all. More than
	// this is reported as a cut-off list, never as a total.
	assetSearchPageSize = 100
)

var assetSearchFields = []string{"id", "name", "type", "providers", "vendor", "last_seen"}

// addressQuery reports whether q is exactly one IP or MAC address. When it is,
// it returns the field to search and the address in the spelling the search
// matches: IPv6 short and lower case, MAC lower case with colons.
func addressQuery(q string) (field, value string, ok bool) {
	q = strings.TrimSpace(q)
	if a, err := netip.ParseAddr(q); err == nil && a.Zone() == "" {
		return "ip_addresses", a.Unmap().String(), true
	}
	// ParseMAC also takes the 8- and 20-byte forms; only a normal 6-byte MAC
	// is something a device list holds.
	if hw, err := net.ParseMAC(q); err == nil && len(hw) == 6 {
		return "mac_addresses", hw.String(), true
	}
	return "", "", false
}

// addressValue is every character an address spelled by addressQuery can
// hold. A quote or a space can never pass it.
var addressValue = regexp.MustCompile(`^[0-9a-f.:]+$`)

var errNotAnAddress = errors.New("not an IP or MAC address")

// addressFilter builds the search filter. The value goes inside single quotes,
// and it is checked first, so no text from the search box can end the quoted
// value early and add a condition of its own.
func addressFilter(field, value string) (string, error) {
	if (field != "ip_addresses" && field != "mac_addresses") || !addressValue.MatchString(value) {
		return "", errNotAnAddress
	}
	return field + " = '" + value + "'", nil
}

// fetchAssetsByAddress is the address half of FetchAssetInventory. It shares
// that function's cache, so it only runs on a miss.
func (s *Service) fetchAssetsByAddress(ctx context.Context, aq AssetQuery, field, value string) map[string]any {
	filter, err := addressFilter(field, value)
	if err != nil {
		return assetsUnavailable(aq, err.Error())
	}
	if s.Rest == nil {
		return assetsUnavailable(aq, "the connection to Infoblox is not set up")
	}
	body, status, err := s.Rest.Write("POST", assetSearchPath, map[string]any{
		"sync":      map[string]any{"mode": "FULL"},
		"page_size": assetSearchPageSize,
		"fields":    assetSearchFields,
		"filter":    filter,
	}, nil)
	return assembleAddressSearch(aq, field, value, body, status, err)
}

// assembleAddressSearch is pure. Its payload is the list payload plus mode,
// what was matched, and the 7-day window, so the page can say why an empty
// answer is empty.
func assembleAddressSearch(aq AssetQuery, field, value string, body any, status int, err error) map[string]any {
	aq.Page = 0
	fail := func(reason string) map[string]any {
		out := assetsUnavailable(aq, reason)
		out["mode"] = "address"
		return out
	}
	switch {
	case err != nil || status == 0:
		return fail("Infoblox could not be reached for the address search")
	case status == 400:
		return fail("Infoblox did not accept that address")
	case status >= 300:
		return fail("the address search failed upstream (status " + strconv.Itoa(status) + ")")
	}
	m, _ := body.(map[string]any)
	data, ok := m["data"].([]any)
	if m == nil || (!ok && m["data"] != nil) {
		return fail("the address search answered in a shape this app does not know")
	}
	rows := make([]any, 0, len(data))
	for _, d := range data {
		r, _ := d.(map[string]any)
		if r == nil || getStr(r["id"]) == "" {
			// Same rule as the cube list: a hit with no id cannot be opened or
			// keyed, so the whole answer is not trusted.
			return fail("the address search returned a device with no id")
		}
		rows = append(rows, map[string]any{
			"cqid":      getStr(r["id"]),
			"name":      getStr(r["name"]),
			"type":      joinLabels(r["type"]),
			"provider":  joinLabels(r["providers"]),
			"vendor":    getStr(r["vendor"]),
			"last_seen": getStr(r["last_seen"]),
		})
	}
	pg, _ := m["pagination"].(map[string]any)
	truncated := getStr(pg["next_page_token"]) != ""
	var total any = len(rows)
	if truncated {
		total = nil
	}
	matched := "ip"
	if field == "mac_addresses" {
		matched = "mac"
	}
	return map[string]any{
		"rows":         rows,
		"total":        total,
		"truncated":    truncated,
		"has_more":     false,
		"page":         0,
		"page_size":    assetSearchPageSize,
		"sort":         aq.Sort,
		"dir":          aq.Dir,
		"availability": "ok",
		"mode":         "address",
		"matched":      matched,
		"address":      value,
		"window_days":  assetSearchWindowDays,
	}
}

// joinLabels turns the search API's [{"id":..,"label":..}] lists into "a, b".
func joinLabels(v any) string {
	list, _ := v.([]any)
	parts := make([]string, 0, len(list))
	for _, it := range list {
		m, _ := it.(map[string]any)
		l := strings.TrimSpace(getStr(m["label"]))
		if l == "" {
			l = strings.TrimSpace(getStr(m["id"]))
		}
		if l != "" {
			parts = append(parts, l)
		}
	}
	return strings.Join(parts, ", ")
}
