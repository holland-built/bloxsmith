package dashboard

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

func staleRecords(n int) []fakeRecord {
	out := make([]fakeRecord, n)
	for i := range out {
		out[i] = fakeRecord{Name: "r" + strconv.Itoa(i), Zone: "corp.example.", Flags: []string{"Stale"}}
	}
	return out
}

// A real zero is ok with a count of 0, never unknown.
func TestVisRead_ZeroIsACount(t *testing.T) {
	f := &visTenant{}
	got := f.service(t).readDNSFlag(context.Background(), "Dangling", 0)
	if !got.Count.OK() || got.Count.N() != 0 {
		t.Fatalf("no flagged records: want ok 0, got %+v", got.Count)
	}
}

// Cube.js answering 200 with "Continue wait", a failed read and a refusal are
// three different outcomes, and none of them is 0.
func TestVisRead_FailuresAreNotZero(t *testing.T) {
	cases := map[string]struct {
		status int
		body   string
		want   string
	}{
		"continue wait": {200, `{"error":"Continue wait"}`, MetricUnknown},
		"server error":  {500, `{"error":"boom"}`, MetricUnknown},
		"refused":       {403, `{"error":"forbidden"}`, MetricForbidden},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := &visTenant{Records: staleRecords(3), Fail: func(*http.Request) (int, string) { return c.status, c.body }}
			got := f.service(t).readDNSFlag(context.Background(), "Stale", 0).Count
			if got.Status != c.want || got.Count != nil || got.Reason == "" {
				t.Fatalf("want %s with a reason and no count, got %+v", c.want, got)
			}
		})
	}
}

// A read the deadline stopped says the time ran out.
func TestVisRead_DeadlineSaysTimeRanOut(t *testing.T) {
	f := &visTenant{Records: staleRecords(3)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := f.service(t).readDNSFlag(ctx, "Stale", 0).Count
	if got.Status != MetricUnknown || got.Reason != reasonTimeUp {
		t.Fatalf("want unknown with the time-up reason, got %+v", got)
	}
}

// The count comes from its own aggregate query, so a sample capped at 25 does
// not cap the count.
func TestVisRead_DNSCountIndependentOfSample(t *testing.T) {
	f := &visTenant{Records: staleRecords(30)}
	got := f.service(t).readDNSFlag(context.Background(), "Stale", 25)
	if !got.Count.OK() || got.Count.N() != 30 {
		t.Fatalf("want a count of 30, got %+v", got.Count)
	}
	if !got.SampleOK || len(got.Sample) != 25 {
		t.Fatalf("want a 25-row sample, got ok=%v len=%d", got.SampleOK, len(got.Sample))
	}
}

// Flags the assessment doesn't name are reported by name, not guessed into a count.
func TestVisRead_OtherDNSFlagsNamed(t *testing.T) {
	f := &visTenant{Records: []fakeRecord{
		{Name: "a", Zone: "z.", Flags: []string{"Dangling"}},
		{Name: "b", Zone: "z.", Flags: []string{"Lame Delegation", "Stale"}},
		{Name: "c", Zone: "z.", Flags: []string{"Lame Delegation"}},
	}}
	other, m := f.service(t).readDNSOtherFlags(context.Background())
	if !m.OK() || len(other) != 1 || other["Lame Delegation"] != 2 {
		t.Fatalf("want Lame Delegation 2, got %v %+v", other, m)
	}
}

func TestVisRead_RestCountUsesServerTotal(t *testing.T) {
	f := &visTenant{Subnets: []fakeSubnet{{CIDR: 24, Util: 5}, {CIDR: 24, Util: 90}, {CIDR: 24, Util: 10}}}
	got := f.service(t).restCountCtx(context.Background(), "/api/ddi/v1/ipam/subnet",
		map[string]string{"_filter": "utilization.utilization<20"})
	if !got.OK() || got.N() != 2 {
		t.Fatalf("want 2, got %+v", got)
	}
	if !strings.Contains(strings.Join(f.Calls, " "), "_limit=1") {
		t.Fatalf("a count should ask for one row: %v", f.Calls)
	}
}

func TestParseFlagList(t *testing.T) {
	got := parseFlagList("['Abandoned','Stale','Untrusted']")
	if strings.Join(got, "|") != "Abandoned|Stale|Untrusted" {
		t.Fatalf("got %v", got)
	}
}

// A connector read already running for another caller can't hold this one
// past its deadline: the join gives up and the list reads as unavailable.
func TestConnectorHealth_JoinHonoursDeadline(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	s, _ := newAIToolsTestService(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-release
		writeResults(w, nil)
	})
	defer close(release)
	go s.FetchConnectorHealth(context.Background())
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	begin := time.Now()
	got := s.FetchConnectorHealth(ctx)
	if d := time.Since(begin); d > time.Second {
		t.Fatalf("waited %v past a 50ms deadline", d)
	}
	if got["availability"] != "error" {
		t.Fatalf("want an unavailable list, got %v", got)
	}
}
