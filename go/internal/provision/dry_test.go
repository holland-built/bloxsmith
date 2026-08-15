package provision

import "testing"

// TruthyDry decides whether a provision or teardown run is a preview or destroys
// real infrastructure, and every entry point routes through it — site.go,
// block.go, decommission.go, and the five handlers in internal/server. Each row
// carries its expected verdict explicitly rather than "the rest are unchanged",
// because a table whose expectations are implied cannot be read against a diff.
//
// The two rows marked CHANGED are the defect from #59: a present-but-empty
// value used to mean "run it for real".
func TestTruthyDry(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want bool // true = preview
	}{
		{"absent (nil)", nil, true},
		{"empty string", "", true},           // CHANGED: was false — a live run
		{"whitespace only", "   ", true},     // CHANGED: was false — a live run
		{"zero", "0", false},                 // an explicit "no preview"
		{"false", "false", false},            // an explicit "no preview"
		{"FALSE, uppercase", "FALSE", false}, // truthy lowercases before matching
		{"no", "no", false},                  // an explicit "no preview"
		{"one", "1", true},
		{"yes", "yes", true},
		{"unrecognised word", "x", true}, // fails safe, as it already did
		{"typo for true", "ture", true},  // fails safe, as it already did
		{"bool false", false, false},     // a JSON body can send a real bool
		{"bool true", true, true},
		{"json number 0", float64(0), false}, // pyStr(0) -> "0"
		{"json number 1", float64(1), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := TruthyDry(c.in)
			if got != c.want {
				verdict := map[bool]string{true: "preview", false: "LIVE RUN"}
				t.Fatalf("TruthyDry(%#v) = %s, want %s", c.in, verdict[got], verdict[c.want])
			}
		})
	}
}
