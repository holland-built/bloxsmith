package dashboard

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"bloxsmith/internal/cache"
	"bloxsmith/internal/rest"
)

// metaFixture is a /meta answer in Infoblox's shape (fields as seen in the
// live catalog on 2026-11-10): one current cube, one deprecated by its
// lifecycle stage, one with nothing to count, one current cube with a
// deprecated and a hidden member.
const metaFixture = `{"result":{"cubes":[
 {"name":"DnsActivityV1","title":"DNS Activity","description":"DNS queries.","type":"cube","public":true,"isVisible":true,
  "meta":{"deprecated":false,"lifecycleStage":"stable","successor":null},
  "measures":[{"name":"DnsActivityV1.total_query_count","title":"DNS Activity Total Query Count","shortTitle":"Total Query Count","type":"number","isVisible":true,"public":true,"aggType":"count","drillMembers":[]}],
  "dimensions":[
   {"name":"DnsActivityV1.device_name","title":"DNS Activity Device Name","shortTitle":"Device Name","type":"string","isVisible":true,"public":true},
   {"name":"DnsActivityV1.timestamp","title":"DNS Activity Timestamp","shortTitle":"Timestamp","type":"time","isVisible":true,"public":true},
   {"name":"DnsActivityV1.old_field","shortTitle":"Old","type":"string","isVisible":true,"public":true,"meta":{"deprecated":true,"successor":"DnsActivityV1.device_name"}},
   {"name":"DnsActivityV1.secret","shortTitle":"Hidden","type":"string","isVisible":false,"public":true}]},
 {"name":"DnsActivity","title":"DNS Activity (old)","type":"cube","public":true,"isVisible":true,
  "meta":{"deprecated":true,"lifecycleStage":"deprecated","successor":"DnsActivityV1","sunsetDate":"2027-01-01"},
  "measures":[{"name":"DnsActivity.count","shortTitle":"Count","type":"number","isVisible":true,"public":true}],"dimensions":[]},
 {"name":"OnlyStage","title":"Only Stage","type":"cube","public":true,"isVisible":true,
  "meta":{"lifecycleStage":"deprecated"},
  "measures":[{"name":"OnlyStage.count","shortTitle":"Count","type":"number","isVisible":true,"public":true}],"dimensions":[]},
 {"name":"NoCounts","title":"No Counts","type":"cube","public":true,"isVisible":true,
  "measures":[],"dimensions":[{"name":"NoCounts.x","shortTitle":"X","type":"string","isVisible":true,"public":true}]}
]}}`

const securityMetaFixture = `{"result":{"cubes":[
 {"name":"PortunusAggThreat_ch","title":"Threats","type":"cube","public":true,"isVisible":true,
  "measures":[{"name":"PortunusAggThreat_ch.requests","shortTitle":"Requests","type":"number","isVisible":true,"public":true}],
  "dimensions":[{"name":"PortunusAggThreat_ch.action","shortTitle":"Action","type":"string","isVisible":true,"public":true},
   {"name":"PortunusAggThreat_ch.timestamp","shortTitle":"Timestamp","type":"time","isVisible":true,"public":true}]}
]}}`

func decode(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestTrimCubeMeta_KeepsWhatThePickerNeeds(t *testing.T) {
	got := trimCubeMeta(decode(t, metaFixture), cubeEndpoint)
	if len(got) != 1 || got[0].Name != "DnsActivityV1" {
		t.Fatalf("cubes = %+v, want only DnsActivityV1", got)
	}
	c := got[0]
	if c.Title != "DNS Activity" || c.Description != "DNS queries." || c.endpoint != cubeEndpoint {
		t.Fatalf("cube = %+v", c)
	}
	if len(c.Measures) != 1 || c.Measures[0] != (CubeMember{"DnsActivityV1.total_query_count", "Total Query Count", "number"}) {
		t.Fatalf("measures = %+v", c.Measures)
	}
	want := []CubeMember{{"DnsActivityV1.device_name", "Device Name", "string"}, {"DnsActivityV1.timestamp", "Timestamp", "time"}}
	if len(c.Dimensions) != 2 || c.Dimensions[0] != want[0] || c.Dimensions[1] != want[1] {
		t.Fatalf("dimensions = %+v, want %+v (deprecated and hidden left out)", c.Dimensions, want)
	}
	// Trimmed means trimmed: nothing beyond name, title, type survives.
	b, _ := json.Marshal(c.Measures[0])
	if string(b) != `{"name":"DnsActivityV1.total_query_count","title":"Total Query Count","type":"number"}` {
		t.Fatalf("member json = %s", b)
	}
}

func TestTrimCubeMeta_SkipsDeprecatedCubes(t *testing.T) {
	for _, c := range trimCubeMeta(decode(t, metaFixture), cubeEndpoint) {
		if c.Name == "DnsActivity" || c.Name == "OnlyStage" {
			t.Fatalf("deprecated cube %s kept", c.Name)
		}
	}
}

func TestNewCubeCatalog_SecurityServiceWinsAName(t *testing.T) {
	sec := trimCubeMeta(decode(t, securityMetaFixture), cubeSecurityEndpoint)
	main := append(trimCubeMeta(decode(t, metaFixture), cubeEndpoint),
		CatalogCube{Name: "PortunusAggThreat_ch", Title: "Threats", Measures: []CubeMember{{"PortunusAggThreat_ch.requests", "R", "number"}}, endpoint: cubeEndpoint})
	cat := newCubeCatalog(sec, main)
	if len(cat.Cubes) != 2 {
		t.Fatalf("cubes = %d, want 2", len(cat.Cubes))
	}
	c, ok := cat.Cube("PortunusAggThreat_ch")
	if !ok || c.endpoint != cubeSecurityEndpoint {
		t.Fatalf("threat cube = %+v, want the security service", c)
	}
	if cat.Cubes[0].Title != "DNS Activity" {
		t.Fatalf("not sorted by title: %s first", cat.Cubes[0].Title)
	}
}

func testCatalog(t *testing.T) *CubeCatalog {
	return newCubeCatalog(trimCubeMeta(decode(t, securityMetaFixture), cubeSecurityEndpoint),
		trimCubeMeta(decode(t, metaFixture), cubeEndpoint))
}

func TestBuildQuery_AcceptsOnlyListedMembers(t *testing.T) {
	cat := testCatalog(t)
	m := "DnsActivityV1.total_query_count"
	bad := []AnyPicks{
		{},
		{Cube: "Nope", Measure: m},
		{Cube: "DnsActivity", Measure: "DnsActivity.count"},                                       // deprecated cube
		{Cube: "DnsActivityV1", Measure: "DnsActivityV1.nope"},                                    // unknown measure
		{Cube: "DnsActivityV1", Measure: "PortunusAggThreat_ch.requests"},                         // another cube's measure
		{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.old_field", Top: 10},            // deprecated member
		{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.secret", Top: 10},               // hidden member
		{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.device_name"},                   // split without a top N
		{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.device_name", Top: 7},           // top N off the menu
		{Cube: "DnsActivityV1", Measure: m, Top: 10},                                              // top N without a split
		{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.timestamp", Top: 10},            // a date is not a split
		{Cube: "DnsActivityV1", Measure: m, Time: "DnsActivityV1.device_name", Window: "7d"},      // not a date
		{Cube: "DnsActivityV1", Measure: m, Time: "DnsActivityV1.timestamp", Window: "now"},       // no date range
		{Cube: "DnsActivityV1", Measure: m, Time: "DnsActivityV1.timestamp", Window: "1y"},        // off the menu
		{Cube: "DnsActivityV1", Measure: m, Time: "DnsActivityV1.timestamp"},                      // window missing
		{Cube: "DnsActivityV1", Measure: m, Window: "7d"},                                         // date field missing
		{Cube: "DnsActivityV1", Measure: m + `","x`, Split: "DnsActivityV1.device_name", Top: 10}, // injection
	}
	for _, p := range bad {
		if q, _, err := cat.BuildQuery(p); err == nil {
			t.Errorf("%+v accepted: %v", p, q)
		}
	}
	q, ep, err := cat.BuildQuery(AnyPicks{Cube: "DnsActivityV1", Measure: m, Split: "DnsActivityV1.device_name", Top: 10,
		Time: "DnsActivityV1.timestamp", Window: "7d"})
	if err != nil || ep != cubeEndpoint {
		t.Fatalf("good picks: %v %s", err, ep)
	}
	b, _ := json.Marshal(q)
	want := `{"dimensions":["DnsActivityV1.device_name"],"limit":10,"measures":["DnsActivityV1.total_query_count"],"order":{"DnsActivityV1.total_query_count":"desc"},"timeDimensions":[{"dateRange":"last 7 days","dimension":"DnsActivityV1.timestamp"}]}`
	if string(b) != want {
		t.Fatalf("query = %s\nwant    %s", b, want)
	}
	if _, ep, err := cat.BuildQuery(AnyPicks{Cube: "PortunusAggThreat_ch", Measure: "PortunusAggThreat_ch.requests"}); err != nil || ep != cubeSecurityEndpoint {
		t.Fatalf("security cube: %v %s", err, ep)
	}
}

func TestCatalogStore_OneFetchForManyCallers(t *testing.T) {
	st := newCatalogStore(time.Hour)
	var calls int32
	release := make(chan struct{})
	fetch := func() (*CubeCatalog, error) {
		atomic.AddInt32(&calls, 1)
		<-release
		return &CubeCatalog{byName: map[string]int{}}, nil
	}
	var wg sync.WaitGroup
	results := make([]*CubeCatalog, 20)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], _ = st.get("k", fetch)
		}()
	}
	// Let every caller arrive before the one fetch answers.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if calls != 1 {
		t.Fatalf("fetches = %d, want 1", calls)
	}
	for _, r := range results {
		if r == nil || r != results[0] {
			t.Fatal("callers did not share the one answer")
		}
	}
	// Fresh: no new fetch.
	st.get("k", fetch)
	if calls != 1 {
		t.Fatalf("fresh catalog fetched again (%d)", calls)
	}
}

func TestCatalogStore_ExpiresAndDoesNotKeepFailures(t *testing.T) {
	st := newCatalogStore(time.Hour)
	now := time.Unix(0, 0)
	st.now = func() time.Time { return now }
	var calls int
	fail := true
	fetch := func() (*CubeCatalog, error) {
		calls++
		if fail {
			return nil, errors.New("upstream down")
		}
		return &CubeCatalog{byName: map[string]int{}}, nil
	}
	if _, err := st.get("k", fetch); err == nil {
		t.Fatal("failure reported as success")
	}
	fail = false
	if c, err := st.get("k", fetch); err != nil || c == nil || calls != 2 {
		t.Fatalf("failure was kept: calls=%d err=%v", calls, err)
	}
	now = now.Add(59 * time.Minute)
	st.get("k", fetch)
	if calls != 2 {
		t.Fatalf("refetched inside the hour: %d", calls)
	}
	now = now.Add(2 * time.Minute)
	st.get("k", fetch)
	if calls != 3 {
		t.Fatalf("did not refetch after the hour: %d", calls)
	}
}

// metaServer answers both /meta paths, or fails the security one.
func metaServer(t *testing.T, failSecurity bool) (*Service, *int32) {
	t.Helper()
	var metaCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case cubeSecurityMetaPath:
			atomic.AddInt32(&metaCalls, 1)
			if failSecurity {
				w.WriteHeader(502)
				return
			}
			w.Write([]byte(securityMetaFixture))
		case cubeMetaPath:
			atomic.AddInt32(&metaCalls, 1)
			w.Write([]byte(metaFixture))
		default:
			w.Write([]byte(`{"result":{"data":[{"DnsActivityV1.total_query_count":"5"}]}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return New(rest.New(srv.URL, rest.NewAuth("k", nil)), cache.New()), &metaCalls
}

func TestCubeList_FailedFetchIsAnErrorNotAnEmptyList(t *testing.T) {
	s, _ := metaServer(t, true)
	res := s.CubeList()
	if res["status"] != "error" {
		t.Fatalf("status = %v, want error", res["status"])
	}
	if _, has := res["cubes"]; has {
		t.Fatal("a failed fetch must not carry a cubes list")
	}
}

func TestCubeList_FetchesTheMetaOnceAndSendsNoFields(t *testing.T) {
	s, calls := metaServer(t, false)
	res := s.CubeList()
	cubes, _ := res["cubes"].([]map[string]string)
	if res["status"] != "ok" || len(cubes) != 2 {
		t.Fatalf("list = %v", res)
	}
	s.CubeList()
	s.CubeFields("DnsActivityV1")
	if *calls != 2 {
		t.Fatalf("meta fetched %d times, want 2 (each service once)", *calls)
	}
	if f := s.CubeFields("DnsActivity"); f["status"] != "invalid" {
		t.Fatalf("deprecated cube fields = %v", f)
	}
}
