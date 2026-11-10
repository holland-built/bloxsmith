// Package pyconv holds the Python-style value coercions that internal/edit and
// internal/provision both use on decoded JSON and YAML values. They were two
// copies that had drifted: only provision's handled int and int64.
package pyconv

import (
	"fmt"
	"strconv"
	"strings"
)

// Str mirrors Python str() for scalars from YAML/JSON.
func Str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// IsFalsy mirrors Python truthiness: nil, "", false, 0, and empty lists and
// maps are falsy.
func IsFalsy(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return t == ""
	case bool:
		return !t
	case int:
		return t == 0
	case int64:
		return t == 0
	case float64:
		return t == 0
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	default:
		return false
	}
}

// Int is Python int(x): int/float truncates toward zero, numeric string
// parses, bool is 0 or 1, else (0,false).
func Int(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case int64:
		return int(t), true
	case float64:
		return int(t), true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// Truthy is _truthy (server.py:1342): nil->def; real bool->itself; else
// str(v).strip().lower() not in {"0","false","no",""}.
func Truthy(v any, def bool) bool {
	if v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	switch strings.ToLower(strings.TrimSpace(Str(v))) {
	case "0", "false", "no", "":
		return false
	}
	return true
}
