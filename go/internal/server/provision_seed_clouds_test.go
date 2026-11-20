package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// The demo seed's cloud choices (aws, azure, gcp) against the real template
// tree: a ticked cloud gets its own block and sites, an unticked one gets
// nothing, and the default run never touches a cloud.

// recordingUpstream answers like allSucceededUpstream and keeps every query's
// _filter and _tfilter, so a test can see what the run looked for.
func recordingUpstream() (http.HandlerFunc, func() string) {
	var mu sync.Mutex
	var seen []string
	h := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.URL.Query().Get("_filter")+" "+r.URL.Query().Get("_tfilter"))
		mu.Unlock()
		allSucceededUpstream(w, r)
	}
	return h, func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.Join(seen, "\n")
	}
}

func TestSeedDemo_AWSOnly_SeedsAWSBlockAndSitesOnly(t *testing.T) {
	up, seen := recordingUpstream()
	d := newSeedStreamDeps(t, up)
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("regions=aws&dry=1"))
	body := rr.Body.String()
	frames := parseSSEFrames(t, body)

	if !strings.Contains(body, "Creating address block 10.48.0.0/12") {
		t.Fatalf("the AWS block 10.48.0.0/12 was not planned; body=%s", body)
	}
	for _, other := range []string{"10.64.0.0/12", "10.80.0.0/12", "10.0.0.0/12", "10.16.0.0/12", "10.32.0.0/12"} {
		if strings.Contains(body, other) {
			t.Fatalf("an aws-only run planned block %s, which it did not tick; body=%s", other, body)
		}
	}
	succeeded := summaryList(t, frames, "succeeded")
	want := map[string]bool{"blocks/cloud_address_blocks.yaml (aws)": false, "aws/production/site-aws-us-east.yaml": false}
	for _, s := range succeeded {
		if _, ok := want[s]; !ok {
			t.Fatalf("succeeded has %q, which an aws-only run should not touch; all=%v", s, succeeded)
		}
		want[s] = true
	}
	for k, ok := range want {
		if !ok {
			t.Fatalf("succeeded = %v, missing %s; body=%s", succeeded, k, body)
		}
	}
	if !strings.Contains(seen(), `Region=="AWS"`) {
		t.Fatalf("the AWS site never looked for a block tagged Region AWS; queries:\n%s", seen())
	}
}

func TestSeedDemo_DefaultRegions_NoCloudBlocks(t *testing.T) {
	d := newSeedStreamDeps(t, allSucceededUpstream)
	rr := httptest.NewRecorder()
	d.provisionSeedDemoStream(rr, seedStreamRequest("dry=1"))
	body := rr.Body.String()
	for _, cloud := range []string{"cloud_address_blocks", "10.48.0.0", "10.64.0.0", "10.80.0.0", "site-aws-", "site-azure-", "site-gcp-"} {
		if strings.Contains(body, cloud) {
			t.Fatalf("the default run (amer,emea,apac) mentions %q; body=%s", cloud, body)
		}
	}
	if !strings.Contains(body, "blocks/regional_address_blocks.yaml") {
		t.Fatalf("the default run no longer seeds the regional blocks; body=%s", body)
	}
}

func TestTeardownSeedDemo_AWSOnly_TargetsAWSSitesAndBlock(t *testing.T) {
	up, seen := recordingUpstream()
	d := newSeedStreamDeps(t, up)
	rr := httptest.NewRecorder()
	d.teardownSeedDemoStream(rr, teardownSeedStreamRequest("regions=aws&dry=1"))
	q := seen()
	if !strings.Contains(q, `Site=="aws-us-east"`) {
		t.Fatalf("teardown never looked up the AWS site aws-us-east; queries:\n%s\nbody=%s", q, rr.Body.String())
	}
	if !strings.Contains(q, `Template=="cloud_address_blocks_aws"`) {
		t.Fatalf("teardown never looked for the AWS block by its template tag; queries:\n%s", q)
	}
	for _, other := range []string{`cloud_address_blocks_azure`, `cloud_address_blocks_gcp`, `Template=="regional_address_blocks"`,
		`azure-west-europe`, `gcp-us-central`, `amer-hq`} {
		if strings.Contains(q, other) {
			t.Fatalf("an aws-only teardown looked for %s; queries:\n%s", other, q)
		}
	}
}
