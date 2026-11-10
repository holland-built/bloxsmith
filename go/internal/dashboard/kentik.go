package dashboard

// Kentik: what one IP address is doing on the network, for the search result
// page. Kentik is a separate vendor on a separate login, like Axur, so nothing
// here goes through the Infoblox REST client. That client sends one
// Authorization header; Kentik wants two of its own (X-CH-Auth-Email and
// X-CH-Auth-API-Token), so this file makes its one call with net/http.
//
// ONE request per lookup. Kentik's v5 Query API takes several queries in one
// POST, and this sends four for the last hour: the address's total traffic out,
// its total in, its busiest destinations and its busiest sources. The totals
// come from Kentik's "Traffic" dimension, which is the whole flow volume, not a
// sum of the top rows. Measured 2026-11-10 against the demo account: 0.9 s for
// all four, and the account allows 50 requests a minute.
//
// The outcomes stay apart, because they send an operator to different places:
//   - not set up: no login stored. availability "unsupported", says where.
//   - vault locked: a login may be stored but cannot be read. "unsupported".
//   - failed: transport, status, or a reply missing any of the four answers.
//     availability "error", never zero rows.
//   - loaded: availability "ok". Zero rows only when Kentik answered all four
//     and saw nothing, which the page words as no traffic.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"bloxsmith/internal/cache"
)

const (
	// KentikDefaultURL is the US query endpoint. The EU host rejects a US login.
	KentikDefaultURL = "https://api.kentik.com/api/v5/query/topXdata"
	kentikLookback   = 3600
	kentikTopN       = 8
	kentikTimeout    = 20 * time.Second
)

var kentikHTTP = &http.Client{Timeout: kentikTimeout}

// kentikBuckets names the four queries. Every one must come back in the reply,
// or the read failed.
var kentikBuckets = []string{"out_total", "in_total", "out_top", "in_top"}

func kentikQuery(bucket, field, ip string, dims []string) map[string]any {
	return map[string]any{
		"bucket":      bucket,
		"bucketIndex": 0,
		"query": map[string]any{
			"metric":           "bytes",
			"dimension":        dims,
			"topx":             fmt.Sprint(kentikTopN),
			"depth":            kentikTopN,
			"fastData":         "Auto",
			"outsort":          "avg_bits_per_sec",
			"lookback_seconds": kentikLookback,
			"time_format":      "UTC",
			"hostname_lookup":  false,
			// Required: Kentik answers 400 "The device_name is required" without
			// it. Empty plus all_selected means every device.
			"device_name":  []string{},
			"all_selected": true,
			"filters_obj": map[string]any{
				"connector": "All",
				"filterGroups": []any{map[string]any{
					"connector": "All", "not": false,
					// ILIKE, not "=": Kentik rejects "=" on address fields. ILIKE
					// with no wildcard is an exact match (10.67.44.1 does not
					// match 10.67.44.11, checked).
					"filters": []any{map[string]any{"filterField": field, "operator": "ILIKE", "filterValue": ip}},
				}},
			},
			// avg_bits_per_sec is bits per second despite the bytes column:
			// 3.1 Mb/s over 260 packets/s is 1,490-byte packets, checked.
			"aggregates": []any{map[string]any{"name": "avg_bits_per_sec", "column": "f_sum_both_bytes", "fn": "average", "sample_rate": 1}},
		},
	}
}

func kentikFingerprint(email, token string) string {
	sum := sha256.Sum256([]byte(email + "\x00" + token))
	return hex.EncodeToString(sum[:])[:12]
}

// FetchKentikTraffic answers "what is this IP doing" from Kentik.
func (s *Service) FetchKentikTraffic(q string) map[string]any {
	ip := net.ParseIP(q)
	if ip == nil {
		return map[string]any{"availability": "unsupported", "rows": []any{}, "reason": "Kentik is searched by IP address, and this is not one."}
	}
	addr := ip.String()
	// One read of the login, used for the decision, the cache key and the call.
	var email, token string
	if s.KentikCreds != nil {
		email, token = s.KentikCreds()
	}
	if token == "" {
		reason := "Kentik is not set up. Add the Kentik login email and API token in Settings, under Integrations."
		if s.KentikLocked != nil && s.KentikLocked() {
			reason = "Vault locked. Unlock it to read Kentik."
		}
		return map[string]any{"availability": "unsupported", "configured": false, "rows": []any{}, "reason": reason}
	}

	ck := cache.Key("kentik_traffic", addr, map[string]string{"cred": kentikFingerprint(email, token)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()

	res, err := s.kentikCall(email, token, addr)
	if err != nil {
		log.Printf("kentik: traffic for %s failed: %v", addr, err)
		// Not cached: a failure is usually what the operator is fixing.
		return map[string]any{"availability": "error", "configured": true, "rows": []any{}, "reason": err.Error()}
	}
	s.Cache.SetGen(ck, res, g)
	return res
}

func (s *Service) kentikCall(email, token, ip string) (map[string]any, error) {
	body, _ := json.Marshal(map[string]any{"queries": []any{
		kentikQuery("out_total", "inet_src_addr", ip, []string{"Traffic"}),
		kentikQuery("in_total", "inet_dst_addr", ip, []string{"Traffic"}),
		kentikQuery("out_top", "inet_src_addr", ip, []string{"IP_dst", "Proto", "Port_dst"}),
		kentikQuery("in_top", "inet_dst_addr", ip, []string{"IP_src", "Proto", "Port_dst"}),
	}})
	url := s.KentikURL
	if url == "" {
		url = KentikDefaultURL
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-CH-Auth-Email", email)
	req.Header.Set("X-CH-Auth-API-Token", token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := kentikHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Kentik did not answer: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, fmt.Errorf("Kentik refused the login (HTTP %d). Check the email and token in Settings.", resp.StatusCode)
	case resp.StatusCode == 429:
		return nil, fmt.Errorf("Kentik's rate limit was hit (HTTP 429). Try again in a minute.")
	case resp.StatusCode != 200:
		return nil, fmt.Errorf("Kentik answered HTTP %d", resp.StatusCode)
	}

	var parsed struct {
		Results []struct {
			Bucket string           `json:"bucket"`
			Data   []map[string]any `json:"data"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("Kentik's reply could not be read")
	}
	got := map[string][]map[string]any{}
	for _, r := range parsed.Results {
		if r.Data != nil {
			got[r.Bucket] = r.Data
		}
	}
	// All four or nothing. A missing answer is not zero traffic.
	for _, b := range kentikBuckets {
		if _, ok := got[b]; !ok {
			return nil, fmt.Errorf("Kentik's reply was missing part of the answer (%s)", b)
		}
	}

	total := func(rows []map[string]any) float64 {
		var t float64
		for _, r := range rows {
			t += kentikNum(r["avg_bits_per_sec"])
		}
		return t
	}
	out, in := total(got["out_total"]), total(got["in_total"])

	rows := []any{}
	add := func(dir, peerKey string, data []map[string]any) {
		for _, r := range data {
			rows = append(rows, map[string]any{
				"direction": dir,
				"peer":      stripPrefixLen(fmt.Sprint(r[peerKey])),
				"protocol":  r["i_protocol_name"],
				"port":      r["l4_dst_port"],
				"bps":       kentikNum(r["avg_bits_per_sec"]),
			})
		}
	}
	add("out", "inet_dst_addr", got["out_top"])
	add("in", "inet_src_addr", got["in_top"])
	sort.SliceStable(rows, func(i, j int) bool {
		return kentikNum(rows[i].(map[string]any)["bps"]) > kentikNum(rows[j].(map[string]any)["bps"])
	})
	return map[string]any{
		"availability": "ok",
		"configured":   true,
		"ip":           ip,
		"window_sec":   kentikLookback,
		"bps_out":      out,
		"bps_in":       in,
		"rows":         rows,
	}, nil
}

// kentikNum reads a JSON number; anything else is 0.
func kentikNum(v any) float64 {
	f, _ := v.(float64)
	return f
}

// Kentik writes addresses as CIDR ("10.67.70.10/32"); the page shows the address.
func stripPrefixLen(s string) string {
	if i := strings.IndexByte(s, '/'); i > 0 {
		return s[:i]
	}
	return s
}
