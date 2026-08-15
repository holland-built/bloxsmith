package dashboard

import (
	"encoding/json"
	"strings"
	"testing"
)

// The regression this file covers (#89): a dossier carrying only geo, whois or
// threat_actor sources — a country, a registrar, an actor name, and no threat
// judgement whatsoever — rendered "Verdict: Clean" above "Threat level: 0".
// Both numbers were fabrications of the same kind: `maxTL` started at 0 and was
// only ever raised, so 0 meant BOTH "graded zero" and "nobody graded it".
//
// The rule now: `assessed` is set by the SAME evidence that can move the level
// or the verdict, never by the mere presence of a container.

func dossierSource(source string, data map[string]any) []any {
	return []any{map[string]any{"params": map[string]any{"source": source}, "data": data}}
}

func recordsSource(records ...any) []any {
	return dossierSource("atp", map[string]any{"records": records})
}

func malwareSourceStats(stats any) []any {
	return dossierSource("malware_analysis", map[string]any{
		"data": map[string]any{"attributes": map[string]any{
			"reputation": float64(-5), "last_analysis_stats": stats, "categories": map[string]any{},
		}},
	})
}

func TestNormDossier_AssessedTracksEvidenceNotContainers(t *testing.T) {
	cases := []struct {
		name          string
		results       []any
		wantAssessed  bool
		wantLevel     any // nil means the key must be JSON null
		wantMalicious bool
	}{
		// --- context-only sources: real data, no judgement ---
		{"geo alone grades nothing",
			dossierSource("geo", map[string]any{"country_name": "United States", "country": "US"}),
			false, nil, false},
		{"whois alone grades nothing",
			dossierSource("whois", map[string]any{"registrar": "Example Registrar"}),
			false, nil, false},
		{"a threat_actor name is context, not a verdict",
			dossierSource("threat_actor", map[string]any{"actor_name": "APT-Example", "display_name": "Example"}),
			false, nil, false},

		// --- containers that carry no judgement ---
		{"a present but empty records list is not an assessment",
			recordsSource(), false, nil, false},
		{"a record that is not a mapping is not an assessment",
			recordsSource("not-a-mapping"), false, nil, false},
		{"a record with no threat_level is not an assessment",
			recordsSource(map[string]any{"class": "Policy", "property": "Policy_NoContent"}), false, nil, false},
		{"a non-numeric threat_level is not an assessment",
			recordsSource(map[string]any{"class": "Policy", "threat_level": "high"}), false, nil, false},
		{"a negative level accuses nobody AND clears nobody",
			recordsSource(map[string]any{"class": "Policy", "threat_level": float64(-1)}), false, nil, false},

		// --- real judgements ---
		{"a record graded zero is somebody looking and finding nothing",
			recordsSource(map[string]any{"class": "Policy", "threat_level": float64(0)}), true, float64(0), false},
		{"a graded threat",
			recordsSource(map[string]any{"class": "Malware", "threat_level": float64(80)}), true, float64(80), true},

		// --- the malware arm reports a COUNT, not a level ---
		{"zero engines flagged it: assessed, and clean",
			malwareSourceStats(map[string]any{"malicious": float64(0), "harmless": float64(70)}), true, nil, false},
		{"engines flagged it",
			malwareSourceStats(map[string]any{"malicious": float64(3)}), true, nil, true},
		{"stats that are not a map assess nothing",
			malwareSourceStats("not-a-map"), false, nil, false},
		{"stats with no numeric malicious count assess nothing",
			malwareSourceStats(map[string]any{"harmless": float64(70)}), false, nil, false},

		// --- mixed: the flags must accumulate, never overwrite ---
		{"an invalid level next to a valid one does not erase the valid one",
			recordsSource(
				map[string]any{"class": "A", "threat_level": "nonsense"},
				map[string]any{"class": "B", "threat_level": float64(0)},
			), true, float64(0), false},
		{"a context source next to a graded one does not un-assess it",
			append(
				dossierSource("geo", map[string]any{"country": "US"}),
				recordsSource(map[string]any{"class": "B", "threat_level": float64(20)})...,
			), true, float64(20), true},
		{"malware stats next to a graded record: both count, the level is the record's",
			append(
				malwareSourceStats(map[string]any{"malicious": float64(0)}),
				recordsSource(map[string]any{"class": "B", "threat_level": float64(5)})...,
			), true, float64(5), true},
		{"the highest valid level wins regardless of order",
			recordsSource(
				map[string]any{"class": "A", "threat_level": float64(90)},
				map[string]any{"class": "B", "threat_level": float64(10)},
			), true, float64(90), true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := normDossier("example.com", "host", tc.results)
			if out["unavailable"] != nil {
				t.Fatalf("unavailable = %v; every fixture here has a usable source and must produce a dossier",
					out["unavailable"])
			}
			summary, ok := out["summary"].(map[string]any)
			if !ok {
				t.Fatalf("summary missing or wrong type: %v", out["summary"])
			}
			if summary["assessed"] != tc.wantAssessed {
				t.Errorf("assessed = %v, want %v", summary["assessed"], tc.wantAssessed)
			}
			if summary["max_threat_level"] != tc.wantLevel {
				t.Errorf("max_threat_level = %#v (%T), want %#v",
					summary["max_threat_level"], summary["max_threat_level"], tc.wantLevel)
			}
			if summary["malicious"] != tc.wantMalicious {
				t.Errorf("malicious = %v, want %v", summary["malicious"], tc.wantMalicious)
			}
			// The pair that made this visible: an unassessed dossier must never
			// carry a level, because the page prints them together.
			if summary["assessed"] == false && summary["max_threat_level"] != nil {
				t.Errorf("an unassessed dossier reported a level of %v", summary["max_threat_level"])
			}
		})
	}
}

// TestNormDossier_UnassessedSerializesAsNull proves the WIRE shape the browser
// actually receives — the same thing insights_unreported_test.go pins for the
// SOC insight fields, and for the same reason: a 0 that reaches the browser is
// a 0 the browser will render.
func TestNormDossier_UnassessedSerializesAsNull(t *testing.T) {
	b, err := json.Marshal(normDossier("example.com", "host",
		dossierSource("geo", map[string]any{"country": "US"})))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(b)
	for _, want := range []string{`"max_threat_level":null`, `"assessed":false`} {
		if !strings.Contains(got, want) {
			t.Errorf("payload missing %s\n%s", want, got)
		}
	}
	if strings.Contains(got, `"max_threat_level":0`) {
		t.Errorf("payload carries a fabricated zero level:\n%s", got)
	}
}
