package dashboard

import "testing"

// The regression this file covers (#87): normDossier flipped the malicious
// verdict on the PRESENCE of a threat_level, so a record TIDE graded 0 —
// checked, and found not to be a threat — accused the indicator anyway. The
// contradiction was visible on screen, because DossierPage prints the verdict
// and the level in the same three-row block: "Malicious" above "0".
//
// This is the third bug in this one verdict, and it points the other way from
// the first two. Those (a failed read, and a successful-but-empty read, both
// rendering a green CLEAN) are recorded in threatintel.go's own comments and
// pinned by threatintel_test.go and dossier_nosource_test.go. They fabricated
// safety; this one fabricated danger.

// dossierWithLevels builds one TIDE source carrying one record per entry in
// levels. A nil entry means the record omits threat_level entirely.
func dossierWithLevels(levels []any) []any {
	records := make([]any, 0, len(levels))
	for _, lv := range levels {
		rec := map[string]any{
			"class": "Policy", "property": "Policy_NoContent",
			"feed_name": "public_doh", "detected": "2026-08-01",
		}
		if lv != nil {
			rec["threat_level"] = lv
		}
		records = append(records, rec)
	}
	return []any{map[string]any{
		"params": map[string]any{"source": "atp"},
		"data":   map[string]any{"records": records},
	}}
}

func TestNormDossier_VerdictNeedsAThreatLevelAboveZero(t *testing.T) {
	cases := []struct {
		name          string
		levels        []any
		wantMalicious bool
		// any, not float64: #89 made "nobody reported a level" nil rather than
		// a fabricated 0, and these rows are exactly where the two differ.
		wantMax any
	}{
		{"a record graded zero is a clean measurement, not an accusation",
			[]any{float64(0)}, false, float64(0)},
		{"the smallest positive grade is still a grade",
			[]any{float64(1)}, true, float64(1)},
		{"a real threat is unchanged",
			[]any{float64(100)}, true, float64(100)},
		{"a record with no level at all decides nothing, and reports no level",
			[]any{nil}, false, nil},
		{"one clean record does not cancel one dirty one",
			[]any{float64(0), float64(50)}, true, float64(50)},
		{"two clean records stay clean",
			[]any{float64(0), float64(0)}, false, float64(0)},
		{"a negative level is nonsense: it accuses nobody AND clears nobody",
			[]any{float64(-1)}, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := normDossier("example.com", "host", dossierWithLevels(tc.levels))
			summary, ok := out["summary"].(map[string]any)
			if !ok {
				t.Fatalf("summary missing or wrong type: %v", out["summary"])
			}
			if summary["malicious"] != tc.wantMalicious {
				t.Errorf("malicious = %v, want %v", summary["malicious"], tc.wantMalicious)
			}
			if summary["max_threat_level"] != tc.wantMax {
				t.Errorf("max_threat_level = %v (%T), want %v", summary["max_threat_level"], summary["max_threat_level"], tc.wantMax)
			}
			// The contradiction that made this visible: these two fields must
			// never disagree about whether anything was found.
			if summary["malicious"] == true && summary["max_threat_level"] == float64(0) {
				t.Errorf("verdict says malicious while the level says 0 — that is the pair the Dossier page prints together")
			}
		})
	}
}

// TestNormDossier_MalwareArmIsIndependent: the malware source sets the verdict
// from an engine COUNT (last_analysis_stats.malicious), not from a level, so a
// zero count was already correctly falsy there and that path must stay live.
// Written as its own test rather than a row in the table above because it
// changes the source structure, not the threat level.
func TestNormDossier_MalwareArmIsIndependent(t *testing.T) {
	malwareSource := func(count any) []any {
		return []any{map[string]any{
			"params": map[string]any{"source": "malware_analysis"},
			"data": map[string]any{"data": map[string]any{
				"attributes": map[string]any{
					"reputation":          float64(-5),
					"last_analysis_stats": map[string]any{"malicious": count},
					"categories":          map[string]any{},
				}}},
		}}
	}

	t.Run("engines reporting malicious still flip the verdict with no threat_level anywhere", func(t *testing.T) {
		summary, _ := normDossier("bad.example", "host", malwareSource(float64(3)))["summary"].(map[string]any)
		if summary["malicious"] != true {
			t.Fatalf("malicious = %v, want true — the malware arm is a separate, still-live path", summary["malicious"])
		}
	})

	t.Run("zero engines is not a verdict", func(t *testing.T) {
		summary, _ := normDossier("ok.example", "host", malwareSource(float64(0)))["summary"].(map[string]any)
		if summary["malicious"] != false {
			t.Fatalf("malicious = %v, want false", summary["malicious"])
		}
	})
}
