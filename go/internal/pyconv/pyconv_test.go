package pyconv

import (
	"encoding/json"
	"fmt"
	"testing"
)

// The behaviour edit and provision relied on before their copies were merged.
// Every row matched both old copies except the int and int64 rows, where only
// provision's copy had a case; edit's fell through to "not falsy" and "not an
// int". The merged version keeps provision's answers.
func TestCoercions(t *testing.T) {
	type row struct {
		in      any
		str     string
		falsy   bool
		truthyT bool
		truthyF bool
		n       int
		nOK     bool
	}
	rows := []row{
		{nil, "", true, true, false, 0, false},
		{"", "", true, false, false, 0, false},
		{" ", " ", false, false, false, 0, false},
		{"0", "0", false, false, false, 0, true},
		{"false", "false", false, false, false, 0, false},
		{"False", "False", false, false, false, 0, false},
		{"NO", "NO", false, false, false, 0, false},
		{"yes", "yes", false, true, true, 0, false},
		{" 7 ", " 7 ", false, true, true, 7, true},
		{"3.9", "3.9", false, true, true, 0, false},
		{true, "True", false, true, true, 1, true},
		{false, "False", true, false, false, 0, true},
		{0.0, "0", true, false, false, 0, true},
		{-2.0, "-2", false, true, true, -2, true},
		{3.9, "3.9", false, true, true, 3, true},
		{0.5, "0.5", false, true, true, 0, true},
		// The rows edit's copy got wrong.
		{int(0), "0", true, false, false, 0, true},
		{int(5), "5", false, true, true, 5, true},
		{int64(0), "0", true, false, false, 0, true},
		{int64(-7), "-7", false, true, true, -7, true},
		{[]any{}, "[]", true, true, true, 0, false},
		{[]any{1}, "[1]", false, true, true, 0, false},
		{map[string]any{}, "map[]", true, true, true, 0, false},
		{map[string]any{"a": 1}, "map[a:1]", false, true, true, 0, false},
		{json.Number("0"), "0", false, false, false, 0, false},
		{int32(3), "3", false, true, true, 0, false},
		{float32(2.5), "2.5", false, true, true, 0, false},
	}
	for _, r := range rows {
		name := fmt.Sprintf("%T(%v)", r.in, r.in)
		if got := Str(r.in); got != r.str {
			t.Errorf("Str(%s) = %q, want %q", name, got, r.str)
		}
		if got := IsFalsy(r.in); got != r.falsy {
			t.Errorf("IsFalsy(%s) = %v, want %v", name, got, r.falsy)
		}
		if got := Truthy(r.in, true); got != r.truthyT {
			t.Errorf("Truthy(%s, true) = %v, want %v", name, got, r.truthyT)
		}
		if got := Truthy(r.in, false); got != r.truthyF {
			t.Errorf("Truthy(%s, false) = %v, want %v", name, got, r.truthyF)
		}
		if n, ok := Int(r.in); n != r.n || ok != r.nOK {
			t.Errorf("Int(%s) = (%d,%v), want (%d,%v)", name, n, ok, r.n, r.nOK)
		}
	}
}
