package dashboard

import (
	"net/http"
	"strings"
	"testing"
)

// --- DEFECT 1 (second route): a lookup that examined NO source ------------
//
// FetchDossier's err != nil arm already refuses to let a FAILED results read
// reach normDossier. It never covered the other route to the same green
// CLEAN pill: a results read that SUCCEEDS but carries nothing usable —
// an empty results list, or records that all lack a `data` object. Every one
// of those was skipped by normDossier's loop, which then returned
// summary{malicious:false, max_threat_level:0} with sources:[] and
// unavailable:nil. DossierPanel accepted that (an empty array IS an array)
// and painted CLEAN for an indicator against which zero sources were checked.
//
// The rule this pins: a verdict requires at least one examined source.
// Zero usable sources => the dossierUnavail shape, no verdict fields at all.
// The third case is the control that stops the fix over-firing: ONE usable
// source among several unusable ones is still a real verdict, and that
// source must survive into the payload.

func TestFetchDossier_NoUsableSource_NoVerdict(t *testing.T) {
	tests := []struct {
		name        string
		query       string
		results     string
		wantVerdict bool
		wantSources []string
		// #89: a payload is not a verdict. A source can be USABLE (it carried a
		// data object, so it survives into `sources`) and still have graded
		// nothing — geo and whois are exactly that. wantAssessed is the field
		// that keeps "we emitted a dossier" and "something judged this
		// indicator" from collapsing into each other the way max_threat_level:0
		// used to.
		wantAssessed bool
	}{
		{
			// TIDE answered 200 with an empty results list.
			name:    "zero results",
			query:   "empty-results.example.com",
			results: `{"results":[]}`,
		},
		{
			// Every record skipped: no `data` key, a non-object `data`,
			// and an empty `data` object — normDossier's three skip paths.
			name:  "every record skipped for want of data",
			query: "no-data.example.com",
			results: `{"results":[
				{"params":{"source":"gsb"}},
				{"params":{"source":"mandiant"},"data":"not-an-object"},
				{"params":{"source":"whois"},"data":{}}
			]}`,
		},
		{
			// The control: three unusable records plus ONE usable geo
			// source. A dossier must still be emitted, with that source
			// present — the fix must not hide real results. But geo reports a
			// country, not a judgement, so the dossier it produces is
			// UNASSESSED: no level, and the UI must not print "Clean".
			name:  "one usable source among unusable ones, and geo grades nothing",
			query: "mixed.example.com",
			results: `{"results":[
				{"params":{"source":"gsb"}},
				{"params":{"source":"mandiant"},"data":{}},
				{"params":{"source":"geo"},"data":{"country_name":"United States","country":"US"}},
				{"params":{"source":"whois"},"data":"not-an-object"}
			]}`,
			wantVerdict:  true,
			wantSources:  []string{"geo"},
			wantAssessed: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newDashboardTestService(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case strings.Contains(r.URL.Path, "/lookup/indicator/"):
					_, _ = w.Write([]byte(`{"job_id":"job-1"}`))
				case strings.Contains(r.URL.Path, "/results"):
					_, _ = w.Write([]byte(tc.results))
				default:
					_, _ = w.Write([]byte(`{}`))
				}
			})

			got := s.FetchDossier(tc.query, "host")

			summary, ok := got["summary"].(map[string]any)
			if !ok {
				t.Fatalf("summary missing or wrong type: %v", got["summary"])
			}
			sources, ok := got["sources"].([]any)
			if !ok {
				t.Fatalf("sources missing or wrong type: %v", got["sources"])
			}

			if !tc.wantVerdict {
				if got["unavailable"] == nil {
					t.Fatalf("unavailable = nil, want a reason: no source was examined")
				}
				if reason, _ := got["unavailable"].(string); strings.Contains(reason, "fetch failed") {
					t.Fatalf("unavailable = %q reads as a fetch failure; this lookup ran and answered", reason)
				}
				// No verdict fields at all — not even false/0, which is
				// exactly what rendered as CLEAN.
				for _, k := range []string{"malicious", "max_threat_level", "threat_classes", "properties"} {
					if v, present := summary[k]; present {
						t.Fatalf("summary[%s] = %v present with zero examined sources: no verdict may be emitted", k, v)
					}
				}
				if len(sources) != 0 {
					t.Fatalf("sources = %v, want empty when nothing usable came back", sources)
				}
				return
			}

			if got["unavailable"] != nil {
				t.Fatalf("unavailable = %v, want nil when a source was genuinely examined", got["unavailable"])
			}
			if summary["malicious"] != false {
				t.Fatalf("summary[malicious] = %v, want false for an examined-but-clean indicator", summary["malicious"])
			}
			// #89: "a dossier was emitted" and "something graded this
			// indicator" are different facts, and max_threat_level:0 used to
			// answer both. A source that graded nothing reports assessed false
			// and NO level at all.
			if summary["assessed"] != tc.wantAssessed {
				t.Fatalf("summary[assessed] = %v, want %v", summary["assessed"], tc.wantAssessed)
			}
			if tc.wantAssessed {
				if summary["max_threat_level"] != float64(0) {
					t.Fatalf("summary[max_threat_level] = %v, want 0", summary["max_threat_level"])
				}
			} else if lvl := summary["max_threat_level"]; lvl != nil {
				t.Fatalf("summary[max_threat_level] = %v on an UNASSESSED dossier; 0 there is the fabrication #89 is about", lvl)
			}
			if summary["malicious"] != false {
				t.Fatalf("summary[malicious] = %v, want false", summary["malicious"])
			}
			var gotNames []string
			for _, si := range sources {
				sm, ok := si.(map[string]any)
				if !ok {
					t.Fatalf("source entry %v is not an object", si)
				}
				gotNames = append(gotNames, getStr(sm["source"]))
			}
			if strings.Join(gotNames, ",") != strings.Join(tc.wantSources, ",") {
				t.Fatalf("sources = %v, want %v — the usable source must survive the fix", gotNames, tc.wantSources)
			}
			if summary["country"] != "United States" {
				t.Fatalf("summary[country] = %v, want the usable source's value to reach the summary", summary["country"])
			}
		})
	}
}
