package audit

import (
	"encoding/json"
	"reflect"
	"strconv"
)

// widen converts a detail value into the closed set of types canonicalJSON's
// encoder accepts, so that an ordinary Go value in an audit detail map does not
// silently cost the operator the entry.
//
// THE BUG THIS CLOSES. canonicalJSON's type switch is closed — nil, bool,
// string, json.Number, float64, int, int64, map[string]any, []any — and its
// default branch is an error. Append propagates that error, and every caller in
// this codebase discards it into a log line, so a detail map holding a []string
// produced an HTTP 200, a line in the server log, and NO AUDIT ENTRY.
// provision-seed-demo, teardown-seed-demo and dns-record-update were written
// that way: a bulk teardown left no record of itself. Three call sites were
// patched individually in v3.47.0; widening here, at the single choke point
// every writer goes through, closes the class rather than three instances of it.
//
// WHAT IT MUST NOT DO. widen sits upstream of the hash input, so for any value
// that already encoded successfully it must produce a byte-identical canonical
// encoding. That is why the accepted types are returned as they are — an int
// must stay an int and not become a json.Number, since "3" and "3" are equal but
// only by luck of formatting, and map/slice contents are copied in place with no
// reordering. The tests in widen_test.go pin that byte-identity directly.
//
// WHAT IT DELIBERATELY DOES NOT DO. A kind with no faithful JSON equivalent —
// a struct, a map keyed by something other than a string, a channel, a func, a
// pointer — is returned UNCHANGED so canonicalJSON still rejects it and the
// refusal is counted by recordAppendFailure. The tempting alternative,
// fmt.Sprintf("%v") on anything unrecognised, would put a Go debug rendering
// into the permanent record and present it as the value the operator supplied.
// A missing entry that is counted and reported is honest; an entry holding an
// invented value is not.
func widen(v any) any {
	// Already in the encoder's accepted set: return the identical value, since
	// anything else here would change the bytes that get hashed.
	switch v.(type) {
	case nil, bool, string, json.Number, float64, int, int64:
		return v
	}

	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		out := make([]any, rv.Len())
		for i := range out {
			out[i] = widen(rv.Index(i).Interface())
		}
		return out

	case reflect.Map:
		// Only string-keyed maps have a JSON object equivalent; anything else
		// falls through to "unchanged" and is refused.
		if rv.Type().Key().Kind() != reflect.String {
			return v
		}
		out := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			out[iter.Key().String()] = widen(iter.Value().Interface())
		}
		return out

	case reflect.Bool:
		return rv.Bool()
	case reflect.String:
		return rv.String()
	case reflect.Int:
		// Only reachable for a NAMED int type; a plain int short-circuits above
		// and must stay an int so its encoding is unchanged.
		return int(rv.Int())
	case reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32:
		// All fit in an int64 without loss.
		return int64(rv.Uint())
	case reflect.Uint64:
		// A uint64 above MaxInt64 cannot become an int64, and cannot become a
		// float64 without losing digits. json.Number carries the exact decimal
		// token through to the hash input.
		return json.Number(strconv.FormatUint(rv.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	}

	return v
}
