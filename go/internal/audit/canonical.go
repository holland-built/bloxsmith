package audit

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// canonicalJSON reproduces Python's json.dumps(v, sort_keys=True) byte-for-byte.
// server.py:2429-2431 hashes each audit entry as
//
//	hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
//
// json.dumps' DEFAULTS are: item separator ", " (comma + SPACE), key separator
// ": " (colon + SPACE), and ensure_ascii=True (every rune <0x20 or >0x7e is
// emitted as \uXXXX, with surrogate pairs above the BMP). sort_keys=True sorts
// object keys by codepoint. Go's encoding/json differs on ALL THREE (compact
// separators, no non-ASCII escaping, escapes <>&) so it cannot be used here —
// any deviation makes existing audit_log.jsonl files verify as tampered.
func canonicalJSON(v any) ([]byte, error) {
	var b strings.Builder
	if err := encode(&b, v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func encode(b *strings.Builder, v any) error {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		encodeString(b, t)
	case json.Number:
		b.WriteString(string(t))
	case float64:
		b.WriteString(pyFloat(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case map[string]any:
		return encodeMap(b, t)
	case []any:
		return encodeSlice(b, t)
	default:
		return fmt.Errorf("canonicalJSON: unsupported type %T", v)
	}
	return nil
}

func encodeMap(b *strings.Builder, m map[string]any) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys) // codepoint order; keys here are ASCII (== Python sort_keys)
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteString(", ")
		}
		encodeString(b, k)
		b.WriteString(": ")
		if err := encode(b, m[k]); err != nil {
			return err
		}
	}
	b.WriteByte('}')
	return nil
}

func encodeSlice(b *strings.Builder, s []any) error {
	b.WriteByte('[')
	for i, v := range s {
		if i > 0 {
			b.WriteString(", ")
		}
		if err := encode(b, v); err != nil {
			return err
		}
	}
	b.WriteByte(']')
	return nil
}

// encodeString matches CPython's py_encode_basestring_ascii: quote, then for
// each rune emit a short escape (\" \\ \b \t \n \f \r), a literal byte for the
// printable ASCII range 0x20-0x7e, or \uXXXX otherwise (surrogate pair >0xFFFF).
func encodeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		case '\b':
			b.WriteString("\\b")
		case '\t':
			b.WriteString("\\t")
		case '\n':
			b.WriteString("\\n")
		case '\f':
			b.WriteString("\\f")
		case '\r':
			b.WriteString("\\r")
		default:
			if r >= 0x20 && r <= 0x7e {
				b.WriteRune(r)
			} else if r <= 0xffff {
				fmt.Fprintf(b, "\\u%04x", r)
			} else {
				u := r - 0x10000
				hi := 0xd800 + (u >> 10)
				lo := 0xdc00 + (u & 0x3ff)
				fmt.Fprintf(b, "\\u%04x\\u%04x", hi, lo)
			}
		}
	}
	b.WriteByte('"')
}

// pyFloat formats a float the way CPython's float repr / json.dumps does within
// the operational range of an audit ts (Unix seconds, ~1.7e9): shortest fixed
// notation, with a trailing ".0" for integral values ("1752624002.0"). Values
// so large or small that Python switches to scientific notation are outside
// that range; a ts never reaches them. Only used for entries THIS binary
// writes — Python-authored chains are read verbatim as json.Number, so their
// tokens never pass through here.
func pyFloat(f float64) string {
	s := strconv.FormatFloat(f, 'f', -1, 64)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return s
}
