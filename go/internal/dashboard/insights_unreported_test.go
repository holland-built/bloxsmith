package dashboard

import (
	"encoding/json"
	"strings"
	"testing"
)

// normInsights used to pad every SOC Insights row with four constants the REST
// /api/v1/insights response never sends: totalVerifiedAssets:0, timeSaved:0,
// count:1, totalTimeSaved:0. The zeros read as measurements ("0 assets
// verified") and `count` surfaced in the UI as a column of literal 1s, because
// the panel picked its columns from the first four (alphabetically sorted)
// keys. These tests pin both halves of the fix: unreported stays unreported,
// and reported passes through untouched.

// insightRow runs one raw upstream row through normInsights and returns the
// single normalized row.
func insightRow(t *testing.T, raw map[string]any) map[string]any {
	t.Helper()
	out := normInsights([]any{raw})
	if len(out) != 1 {
		t.Fatalf("normInsights returned %d rows, want 1", len(out))
	}
	row, ok := out[0].(map[string]any)
	if !ok {
		t.Fatalf("normInsights row is %T, want map[string]any", out[0])
	}
	return row
}

// TestNormInsights_UnreportedFieldsAreNotNumbers is the regression test for the
// invented column: a realistic upstream row reporting none of the impact/effort
// fields must not produce a number for any of them.
func TestNormInsights_UnreportedFieldsAreNotNumbers(t *testing.T) {
	row := insightRow(t, map[string]any{
		"insightId":    "insight-1",
		"tFamily":      "Cobalt Strike",
		"priorityText": "HIGH",
		"status":       "Active",
		"numEvents":    float64(42),
		"feedSource":   "Threat Insight",
		"startedAt":    "2026-07-01T00:00:00Z",
		"mostRecentAt": "2026-07-30T00:00:00Z",
	})

	// Nulled: the concept exists per row, upstream just did not report it.
	for _, k := range []string{"totalVerifiedAssets", "timeSaved"} {
		v, present := row[k]
		if !present {
			t.Errorf("%s: key missing entirely; want present and nil", k)
			continue
		}
		if v != nil {
			t.Errorf("%s = %#v (%T), want nil — upstream reported no such field", k, v, v)
		}
	}

	// Deleted: cube aggregate measures with no per-row meaning and no reader.
	for _, k := range []string{"count", "totalTimeSaved"} {
		if v, present := row[k]; present {
			t.Errorf("%s = %#v, want the key to be gone entirely", k, v)
		}
	}

	// The real mappings are untouched.
	for k, want := range map[string]any{
		"id":            "insight-1",
		"name":          "Cobalt Strike",
		"severity":      "high",
		"currentStatus": "Active",
		"totalEvents":   42,
		"feedSource":    "Threat Insight",
		"startedAt":     "2026-07-01T00:00:00Z",
		"mostRecentAt":  "2026-07-30T00:00:00Z",
	} {
		if row[k] != want {
			t.Errorf("%s = %#v, want %#v", k, row[k], want)
		}
	}
}

// TestNormInsights_UnreportedFieldsSerializeAsNull proves the wire shape the UI
// actually receives: JSON null (rendered as an em-dash), not 0, and no `count`
// key at all — the key whose alphabetical position made it a headline column.
func TestNormInsights_UnreportedFieldsSerializeAsNull(t *testing.T) {
	b, err := json.Marshal(normInsights([]any{map[string]any{"insightId": "i-1"}}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(b)
	for _, want := range []string{`"totalVerifiedAssets":null`, `"timeSaved":null`} {
		if !strings.Contains(got, want) {
			t.Errorf("payload %s\nmissing %s", got, want)
		}
	}
	for _, bad := range []string{`"count":`, `"totalTimeSaved":`, `"totalVerifiedAssets":0`, `"timeSaved":0`} {
		if strings.Contains(got, bad) {
			t.Errorf("payload %s\nmust not contain %s", got, bad)
		}
	}
}

// TestNormInsights_ReportedFieldsPassThrough is the half that stops the fix
// swinging into the opposite lie: a value upstream DID report — including a
// genuine 0 — must survive unchanged. orAny would collapse a reported 0 into
// "unreported"; firstPresent is what keeps them apart.
func TestNormInsights_ReportedFieldsPassThrough(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want map[string]any
	}{
		{
			name: "non-zero values pass through",
			raw: map[string]any{
				"insightId":           "i-2",
				"totalVerifiedAssets": float64(7),
				"timeSaved":           float64(3600),
			},
			want: map[string]any{"totalVerifiedAssets": float64(7), "timeSaved": float64(3600)},
		},
		{
			name: "a reported zero is a measurement, not an absence",
			raw: map[string]any{
				"insightId":           "i-3",
				"totalVerifiedAssets": float64(0),
				"timeSaved":           float64(0),
			},
			want: map[string]any{"totalVerifiedAssets": float64(0), "timeSaved": float64(0)},
		},
		{
			name: "one reported, one not — they do not contaminate each other",
			raw: map[string]any{
				"insightId":           "i-4",
				"totalVerifiedAssets": float64(0),
			},
			want: map[string]any{"totalVerifiedAssets": float64(0), "timeSaved": nil},
		},
		{
			name: "an explicit JSON null counts as not reported",
			raw: map[string]any{
				"insightId":           "i-5",
				"totalVerifiedAssets": nil,
				"timeSaved":           nil,
			},
			want: map[string]any{"totalVerifiedAssets": nil, "timeSaved": nil},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := insightRow(t, tc.raw)
			for k, want := range tc.want {
				if row[k] != want {
					t.Errorf("%s = %#v (%T), want %#v", k, row[k], row[k], want)
				}
			}
		})
	}
}

// TestNormInsights_SeverityIsNeverInvented is the fifth instance of this
// package's oldest defect class and the last one in it: an unreported value
// arriving at the operator as a confident, specific claim. Severity is the
// field a security decision actually turns on, and an insight nobody graded
// used to arrive graded "medium".
//
// Both directions are pinned. An absence must never become a grade, and a
// grade must never become an absence — including a word this code has never
// heard of, which is upstream's measurement and not this code's to overwrite.
func TestNormInsights_SeverityIsNeverInvented(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want string
	}{
		{"the key is absent entirely", map[string]any{"insightId": "i-1"}, "unknown"},
		{"the key is present with JSON null", map[string]any{"insightId": "i-2", "priorityText": nil}, "unknown"},
		{"the key is present but empty", map[string]any{"insightId": "i-3", "priorityText": ""}, "unknown"},
		{"the key is present but only whitespace", map[string]any{"insightId": "i-4", "priorityText": "   "}, "unknown"},
		{"the key is present but not a string", map[string]any{"insightId": "i-5", "priorityText": float64(3)}, "unknown"},
		{"a reported grade is lower-cased and kept", map[string]any{"insightId": "i-6", "priorityText": "HIGH"}, "high"},
		{"a reported grade is trimmed and kept", map[string]any{"insightId": "i-7", "priorityText": "  Critical  "}, "critical"},
		{"a reported grade outside our vocabulary is upstream's measurement, not ours to overwrite",
			map[string]any{"insightId": "i-8", "priorityText": "SEVERE"}, "severe"},
		{"info is a real grade the UI ranks and must survive",
			map[string]any{"insightId": "i-9", "priorityText": "Info"}, "info"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := insightRow(t, tc.raw)["severity"]; got != tc.want {
				t.Errorf("severity = %#v, want %q", got, tc.want)
			}
		})
	}
}
