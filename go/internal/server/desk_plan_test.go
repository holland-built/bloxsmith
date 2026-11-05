package server

import "testing"

// The AI only fills answers. Anything outside the known jobs and answers, or
// in the wrong shape, is dropped before it reaches the page.
func TestParsePlan_KeepsOnlyKnownJobsAndCleanAnswers(t *testing.T) {
	raw := `Sure! {"jobs":[
	  {"job":"branch","answers":{"site":"Austin-Lab","region":"AMER","space_id":"ipam/ip_space/x"},"says":"Set up austin-lab"},
	  {"job":"demo","answers":{"customer":"acme bank","region":"emea","include_server":true}},
	  {"job":"network","answers":{"cidr":16,"name":"big"}},
	  {"job":"delete_everything","answers":{}}
	],"unclear":""}`
	jobs, _ := parsePlan(raw)
	if len(jobs) != 3 {
		t.Fatalf("jobs = %v, want branch, demo, network", jobs)
	}
	b := jobs[0]["answers"].(map[string]any)
	if b["site"] != "austin-lab" || b["region"] != "amer" || b["space_id"] != nil {
		t.Fatalf("branch answers = %v", b)
	}
	d := jobs[1]["answers"].(map[string]any)
	if d["customer"] != nil || d["include_server"] != true {
		t.Fatalf("demo answers = %v, want the bad customer name dropped", d)
	}
	if n := jobs[2]["answers"].(map[string]any); n["cidr"] != nil || n["name"] != "big" {
		t.Fatalf("network answers = %v, want the /16 dropped", n)
	}
	if says := jobs[0]["says"]; says != "Filled in: site austin-lab, in the Americas. Check the rest in the form." {
		t.Fatalf("says = %q, want it written from the answers, not the AI", says)
	}
	if jobs, why := parsePlan("no json here"); len(jobs) != 0 || why == "" {
		t.Fatalf("unreadable answer = %v %q", jobs, why)
	}
}
