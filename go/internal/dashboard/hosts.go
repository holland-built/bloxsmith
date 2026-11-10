package dashboard

// One place that knows how this package reads /api/infra/v1/detail_hosts.
//
// WHY THIS FILE EXISTS. Five readers ask that endpoint for the host estate, and
// they used to disagree about how much of it to ask for: 1000 (dashboard.go),
// 500 (csp.go, analytics.go, sources.go), 200 (hub.go). The repo has measured
// the live tenant TWICE and both numbers are above 500 — page.total_size 532
// (dashboard.go:591-599) and 548 (ai_tools.go:101-107) — so three of those
// readers were silently dropping rows while reporting a count that read as the
// whole estate. Only the two that ask for the authoritative total ever knew.
//
// WHY NOT PAGING. `_offset` has never been sent to this endpoint anywhere in
// this repo; the existing pagers page ipam/subnet and dns/record. Building a
// pager on an unexercised query param is the failure assets.go:206-210 warns
// about — "sending an argument nobody tested is how a working unfiltered query
// turns into a mystery" — and hub.go already takes the same position for a
// sibling feed. So this file does the two things this endpoint is PROVEN to do
// (a 1000-row limit, and the authoritative total) and reports the truncation it
// cannot remove, rather than guessing at one it cannot verify.
//
// Above hostsListLimit rows the estate is still truncated. That is stated, not
// hidden: every caller that has a payload to put it in now says so.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// hostsListLimit is the row limit every host reader in this package sends.
// 1000 is not a truth, it is HEADROOM over two measurements (532, 548) at a
// cost that was measured when dashboard.go adopted it: 0.96s vs 0.93-1.08s for
// 500, i.e. free. A tenant above 1000 hosts is still truncated — the total
// below is how a caller finds that out.
const hostsListLimit = 1000

// hostsReason is the one operator-facing sentence, so four readers cannot word
// the same fact four ways.
var hostsReason = fmt.Sprintf(
	"host list truncated at the %d-row limit — there are more hosts than the rows shown",
	hostsListLimit)

// hostsParams is the one request shape. _is_total_size_needed is not a new
// param on this endpoint: ai_tools.go:104-107 already sends it here alongside
// _limit and _fields, and dashboard.go's fetchCount sends it here too, so the
// combination is proven rather than assumed.
func hostsParams(fields string) map[string]string {
	p := map[string]string{
		"_limit":                strconv.Itoa(hostsListLimit),
		"_is_total_size_needed": "true",
	}
	if fields != "" {
		p["_fields"] = fields
	}
	return p
}

// fetchHosts reads the host estate and reports how much of it it actually saw.
//
// totalOK false means "upstream told us no total", which is NOT the same as
// "there are no more rows" and NOT the same as truncated. A caller with no
// total must make no claim about completeness in either direction — a full page
// with no metadata is not evidence that more rows exist, and this package does
// not guess from len(rows).
func (s *Service) fetchHosts(fields string) (rows []any, total int, totalOK bool, err error) {
	rows, body, err := s.Rest.GetPageStrict("/api/infra/v1/detail_hosts", hostsParams(fields))
	if err != nil {
		return nil, 0, false, err
	}
	if n := pageTotalSize(body, -1); n >= 0 {
		return rows, n, true, nil
	}
	return rows, 0, false, nil
}

// hostsTruncated is the only place a truncation claim is made, and it is made
// on authoritative evidence or not at all: a readable total that exceeds the
// rows in hand. Everything else — no total, a total that agrees, or a total
// smaller than what arrived (an internally inconsistent answer, distrusted the
// way csp.go's totalConsistencyCheck distrusts one) — makes no claim.
func hostsTruncated(rows []any, total int, totalOK bool) bool {
	return totalOK && total > len(rows)
}

// --- host configuration (the DNS or DHCP config a host loaded) --------------

// hostConfigTool is the only source for a host's loaded config: there is no
// REST equivalent. Checked live on 2026-11-10.
const hostConfigTool = "infoblox-hosts_get_host_config"

// HostConfigTypes is the allow-list for config_type. The server route rejects
// anything else before a call is made.
var HostConfigTypes = map[string]bool{"dns": true, "dhcp": true}

var ophidRe = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

// ValidOphid reports whether s is a host's OPH ID: exactly 32 hex characters.
func ValidOphid(s string) bool { return ophidRe.MatchString(s) }

// HiddenValue replaces every secret value before a config leaves the server.
const HiddenValue = "(hidden)"

// Secrets come in two shapes in these files, and both are found by the
// setting's NAME, so a value of any length, type or alphabet is caught. A name
// counts as secret when it contains one of secretWords, case-insensitive.
// That also hides the paths in secret-file and password-file; over-hiding is
// the safe direction. DNSSEC trust anchors (initial-key) are public and stay.
//
//   - Kea (the DHCP files) is JSON. It is decoded, walked, and re-written with
//     indentation, so escaped names ("\u0073ecret") and non-string values are
//     caught. No pattern is run over raw JSON.
//   - BIND (named.conf) is text: `secret "base64...";` inside a key block, the
//     live TSIG key in every DNS sample. Everything from the name to its
//     closing ';' goes, with quoted strings and comments read as opaque, so a
//     ';' inside quotes or a comment before the value cannot end it early.
//
// Then safeToShow scans the result. Anything it cannot vouch for withholds
// the whole file rather than risk sending a secret.
var secretWords = []string{"secret", "password", "passwd", "token", "psk"}

func isSecretName(name string) bool {
	l := strings.ToLower(name)
	for _, w := range secretWords {
		if strings.Contains(l, w) {
			return true
		}
	}
	return false
}

var (
	// A secret word, the rest of its name, then whatever value follows it.
	secretUseRe = regexp.MustCompile(`(?i)(?:secret|password|passwd|token|psk)[\w-]*"?\s*[:=]?\s*`)
	// An escaped character could spell a secret word the scan cannot read.
	unicodeEscRe = regexp.MustCompile(`\\[uU][0-9a-fA-F]{4}`)
)

// RedactConfig hides every secret value in one config file. It returns the
// text, how many values it hid, and ok=false when the file must be withheld
// whole because safeToShow could not confirm nothing is left.
func RedactConfig(text string) (string, int, bool) {
	out, n, isJSON := redactJSON(text)
	if !isJSON {
		out, n = redactText(text)
	}
	if !safeToShow(out) {
		return "", n, false
	}
	return out, n, true
}

// safeToShow is the last check: every secret word must be followed by
// exactly the placeholder, and there must be no \u escape that could hide one.
func safeToShow(text string) bool {
	if unicodeEscRe.MatchString(text) {
		return false
	}
	for _, m := range secretUseRe.FindAllStringIndex(text, -1) {
		if !strings.HasPrefix(text[m[1]:], `"`+HiddenValue+`"`) {
			return false
		}
	}
	return true
}

func redactJSON(text string) (string, int, bool) {
	t := strings.TrimSpace(text)
	if t == "" || (t[0] != '{' && t[0] != '[') {
		return "", 0, false
	}
	dec := json.NewDecoder(strings.NewReader(t))
	dec.UseNumber()
	var v any
	if dec.Decode(&v) != nil || dec.More() {
		return "", 0, false
	}
	n := hideJSON(v)
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "    ")
	if enc.Encode(v) != nil {
		return "", 0, false
	}
	return b.String(), n, true
}

func hideJSON(v any) int {
	n := 0
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			if isSecretName(k) {
				t[k] = HiddenValue
				n++
			} else {
				n += hideJSON(x)
			}
		}
	case []any:
		for _, x := range t {
			n += hideJSON(x)
		}
	}
	return n
}

// redactText reads BIND-style text: quoted strings, /* */, // and # comments
// are copied through whole, and a bare word that names a secret is followed
// by the placeholder in place of everything up to its closing ';'.
func redactText(s string) (string, int) {
	var b strings.Builder
	n := 0
	for i := 0; i < len(s); {
		if j := skipOpaque(s, i); j > i {
			b.WriteString(s[i:j])
			i = j
			continue
		}
		if !isWordByte(s[i]) {
			b.WriteByte(s[i])
			i++
			continue
		}
		j := i
		for j < len(s) && isWordByte(s[j]) {
			j++
		}
		b.WriteString(s[i:j])
		if isSecretName(s[i:j]) {
			b.WriteString(` "` + HiddenValue + `"`)
			n++
			j = skipToSemicolon(s, j) // the ';' itself is copied next
		}
		i = j
	}
	return b.String(), n
}

func isWordByte(c byte) bool {
	return c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// skipOpaque returns the end of a quoted string or comment starting at i, or
// i when none starts there. An unclosed one runs to the end of the text.
func skipOpaque(s string, i int) int {
	switch {
	case s[i] == '"':
		for j := i + 1; j < len(s); j++ {
			if s[j] == '\\' {
				j++
			} else if s[j] == '"' {
				return j + 1
			}
		}
		return len(s)
	case strings.HasPrefix(s[i:], "/*"):
		if k := strings.Index(s[i+2:], "*/"); k >= 0 {
			return i + 2 + k + 2
		}
		return len(s)
	case s[i] == '#' || strings.HasPrefix(s[i:], "//"):
		if k := strings.IndexByte(s[i:], '\n'); k >= 0 {
			return i + k
		}
		return len(s)
	}
	return i
}

// skipToSemicolon returns the index of the ';' that ends the statement
// starting at i, stepping over quoted strings and comments; len(s) if none.
func skipToSemicolon(s string, i int) int {
	for i < len(s) {
		if j := skipOpaque(s, i); j > i {
			i = j
			continue
		}
		if s[i] == ';' {
			return i
		}
		i++
	}
	return len(s)
}

// parseHostConfig turns the tool's text reply into what the browser gets.
// Only named fields pass through, every file is redacted, and an upstream
// error is never echoed (it carries internal storage paths).
//
// "none of [named.conf] present under ..." is what the tool says for a host
// that keeps no such config, seen live for a NIOS grid member (host_type 6).
// That is a plain empty state, not a failure.
func parseHostConfig(text string) map[string]any {
	var v struct {
		Platform    string            `json:"platform"`
		Version     string            `json:"version"`
		Variant     string            `json:"variant"`
		RetrievedAt string            `json:"retrieved_at"`
		Files       map[string]string `json:"files"`
	}
	if json.Unmarshal([]byte(text), &v) != nil || v.Files == nil {
		if strings.HasPrefix(strings.TrimSpace(text), "none of [") {
			return map[string]any{"status": "empty", "files": []any{}}
		}
		log.Printf("dashboard: host config: unexpected reply (%d bytes)", len(text))
		return map[string]any{"status": "error", "files": []any{},
			"reason": "Infoblox did not send this host's settings."}
	}
	names := make([]string, 0, len(v.Files))
	for name := range v.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	files := make([]any, 0, len(names))
	hidden := 0
	for _, name := range names {
		body, n, ok := RedactConfig(v.Files[name])
		hidden += n
		if !ok {
			files = append(files, map[string]any{"name": name, "text": "", "withheld": true})
			continue
		}
		files = append(files, map[string]any{"name": name, "text": body})
	}
	status := "ok"
	if len(files) == 0 {
		status = "empty"
	}
	return map[string]any{
		"status": status, "files": files, "hidden": hidden,
		"platform": v.Platform, "version": v.Version, "variant": v.Variant,
		"retrieved_at": v.RetrievedAt,
	}
}

// withHostConfigKeys adds what the Infra host table needs to open a host's
// config: its ophid, and host_type so a NIOS grid member ("6"), which keeps
// no config here, shows a plain note instead of a call. Only /api/data gets
// these; normHosts' other readers (sources, the AI tool) keep their shape.
// normHosts returns one row per raw item, in order.
func withHostConfigKeys(rows []map[string]any, raw []any) []map[string]any {
	for i, row := range rows {
		if i >= len(raw) {
			break
		}
		h := asMap(raw[i])
		row["ophid"] = getStr(h["ophid"])
		row["host_type"] = getStr(h["host_type"])
	}
	return rows
}

// FetchHostConfig reads the DNS or DHCP config one host loaded. ophid and
// configType must already be validated (ValidOphid, HostConfigTypes).
func (s *Service) FetchHostConfig(ctx context.Context, ophid, configType string) map[string]any {
	const unavailable = "Could not reach Infoblox for this host's settings."
	fail := func(reason string) map[string]any {
		return map[string]any{"status": "error", "files": []any{}, "reason": reason}
	}
	if s.Mcp == nil {
		return fail(unavailable)
	}
	if err := s.Mcp.Initialize(ctx); err != nil {
		return fail(failReason(err, unavailable))
	}
	text, err := s.Mcp.CallTool(ctx, hostConfigTool, map[string]any{
		"ophid": ophid, "config_type": configType,
	})
	if err != nil {
		return fail(failReason(err, unavailable))
	}
	return parseHostConfig(text)
}
