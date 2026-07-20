// Package dashboard ports server.py's read-path aggregation: the _norm_*
// shapers (3201-3363), fetch_dashboard_data (3581) behind /api/data, and the
// three operator-hub fetchers (fetch_hub_health/security/domains 3648-3849). It
// reuses the shared internal/rest proxy for every outbound call and the shared
// internal/cache for TTL parity with the Python warm-loop.
package dashboard

import (
	"strconv"
	"strings"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/mcp"
	"bloxsmith/internal/rest"
)

// Service bundles the two dependencies every fetcher needs. Mcp is the
// hand-rolled MCP client used only by the AI tool loop (RunAITool, Phase 1h);
// the /api/data read path deliberately uses Rest (the parquet path is broken).
type Service struct {
	Rest  *rest.Client
	Cache *cache.Cache
	Mcp   *mcp.Client
}

// New builds the dashboard service.
func New(r *rest.Client, c *cache.Cache) *Service { return &Service{Rest: r, Cache: c} }

// --- Python-semantics coercion helpers --------------------------------------

// asMap coerces a decoded JSON value to an object, empty on mismatch (Python
// `x or {}`).
func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// asSlice coerces to a JSON array, nil on mismatch (Python `x or []`).
func asSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// idOf is Python's x.get("id", ""): the raw value passes through unchanged
// (an id may be a string like "dns/view/…" or a bare int like a named_list's
// numeric id), defaulting to "" when absent. Using getStr here would wrongly
// blank a numeric id.
func idOf(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// getStr is str(x) for a value known to be a string, "" otherwise.
func getStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// truthy is Python truthiness for the `a or b` chains: "", 0, nil, {}, [] and
// false are falsy; everything else is truthy.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int:
		return t != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

// orAny is Python `a or b or c …`: the first truthy value, else the last arg.
func orAny(vals ...any) any {
	for _, v := range vals {
		if truthy(v) {
			return v
		}
	}
	if len(vals) > 0 {
		return vals[len(vals)-1]
	}
	return nil
}

// orStr is orAny rendered as a string.
func orStr(vals ...any) string { return getStr(orAny(vals...)) }

// toInt is Python int(x): truncates floats, parses numeric strings, bool→0/1.
func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case int:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(t)
		if n, err := strconv.Atoi(s); err == nil {
			return n
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return int(f)
		}
	}
	return 0
}

// isDigit is str(x).isdigit(): all runes are ASCII digits and non-empty (used
// by the http_code guards in norm_audit / _num).
func isDigit(v any) bool {
	s := strings.TrimSpace(vToStr(v))
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// vToStr renders a value the way Python str() would for the http_code guard:
// an integer-valued float prints without a trailing ".0".
func vToStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case bool:
		if t {
			return "True"
		}
		return "False"
	}
	return ""
}

// roundHalfEven is Python's round() (banker's rounding) for the utilization %.
func roundHalfEven(x float64) int {
	f := float64(int64(x))
	diff := x - f
	switch {
	case diff > 0.5:
		return int(f) + 1
	case diff < 0.5:
		return int(f)
	default: // exactly .5 -> round to even
		if int64(f)%2 == 0 {
			return int(f)
		}
		return int(f) + 1
	}
}
