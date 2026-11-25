package dashboard

// A fake tenant for the Visibility Assessment tests. It answers the Cube.js
// queries and REST counts the visibility readers send, over made-up assets,
// DNS records and subnets, the way the live services were seen to answer on
// 2026-11-25: prefixed field names, counts as strings, label lists as JSON
// text, page.total_size as a string.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

type fakeAsset struct {
	Type       string
	Providers  []string
	Classes    []string
	Indicators []string
}

type fakeRecord struct {
	Name, Zone string
	Flags      []string
}

type fakeSubnet struct {
	CIDR  int
	Util  int
	Cloud string // "AWS", "Azure", "GCP" or ""
	// Only: "tag" when the subnet carries the cloud tag but no discoverer
	// name, "disc" for the reverse, "" for both.
	Only string
}

type visTenant struct {
	Assets     []fakeAsset
	Records    []fakeRecord
	Subnets    []fakeSubnet
	Connectors []map[string]any
	// Fail, when set, answers a request instead of the fake: return status 0
	// to let it through.
	Fail func(r *http.Request) (int, string)

	mu    sync.Mutex
	Calls []string
}

func (f *visTenant) service(t *testing.T) *Service {
	t.Helper()
	s, _ := newAIToolsTestService(t, f.handle(t))
	return s
}

func (f *visTenant) handle(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.Calls = append(f.Calls, r.URL.Path+"?"+r.URL.RawQuery)
		f.mu.Unlock()
		if f.Fail != nil {
			if st, body := f.Fail(r); st != 0 {
				w.WriteHeader(st)
				_, _ = w.Write([]byte(body))
				return
			}
		}
		switch r.URL.Path {
		case "/api/cubejs/v1/query":
			f.cube(t, w, r)
		case "/api/ddi/v1/ipam/subnet":
			f.subnets(t, w, r)
		case connectorPath:
			writeResults(w, f.Connectors)
		default:
			t.Errorf("fake tenant: unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}
}

type fakeQuery struct {
	Measures   []string
	Dimensions []string
	Filters    []struct {
		Member, Operator string
		Values           []string
	}
	Limit int
}

func jsonList(xs []string) string {
	if xs == nil {
		xs = []string{}
	}
	b, _ := json.Marshal(xs)
	return string(b)
}

func flagList(xs []string) string {
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = "'" + x + "'"
	}
	return "[" + strings.Join(q, ",") + "]"
}

func (f *visTenant) cube(t *testing.T, w http.ResponseWriter, r *http.Request) {
	var q fakeQuery
	if err := json.Unmarshal([]byte(r.URL.Query().Get("query")), &q); err != nil || len(q.Measures) != 1 {
		t.Errorf("fake tenant: bad cube query %s", r.URL.Query().Get("query"))
		w.WriteHeader(400)
		return
	}
	cube, measure, _ := strings.Cut(q.Measures[0], ".")
	// Each source row as a map of field -> text, plus its weight.
	var rows []map[string]string
	switch cube {
	case cubeAssets:
		for _, a := range f.Assets {
			rows = append(rows, map[string]string{
				"taxonomy_type_label":           a.Type,
				"providers_label":               jsonList(a.Providers),
				"insight_classifications_label": jsonList(a.Classes),
				"insight_indicators_label":      jsonList(a.Indicators),
			})
		}
	case dnsRecCube:
		for _, rec := range f.Records {
			rows = append(rows, map[string]string{
				"record_asset_name": rec.Name, "record_asset_absolute_zone_name": rec.Zone,
				"record_asset_record_type": "A", "record_asset_zone_id": "z", "record_asset_dns_rdata": "10.0.0.1",
				"record_asset_last_queried_str": "", "indicator_ids_str": flagList(rec.Flags),
			})
		}
	default:
		t.Errorf("fake tenant: unexpected cube %s", cube)
		w.WriteHeader(400)
		return
	}
	var kept []map[string]string
	for _, row := range rows {
		ok := true
		for _, fl := range q.Filters {
			_, field, _ := strings.Cut(fl.Member, ".")
			v := row[field]
			switch fl.Operator {
			case "contains":
				ok = ok && strings.Contains(v, fl.Values[0])
			case "notContains":
				ok = ok && !strings.Contains(v, fl.Values[0])
			case "equals":
				ok = ok && v == fl.Values[0]
			default:
				t.Errorf("fake tenant: operator %s", fl.Operator)
			}
		}
		if ok {
			kept = append(kept, row)
		}
	}
	// Group by the dimensions, counting rows.
	type group struct {
		key  []string
		n    int
		dims map[string]string
	}
	groups := map[string]*group{}
	var order []string
	for _, row := range kept {
		var key []string
		dims := map[string]string{}
		for _, d := range q.Dimensions {
			_, field, _ := strings.Cut(d, ".")
			key = append(key, row[field])
			dims[d] = row[field]
		}
		k := strings.Join(key, "\x00")
		if groups[k] == nil {
			groups[k] = &group{key: key, dims: dims}
			order = append(order, k)
		}
		groups[k].n++
	}
	if len(q.Dimensions) == 0 && len(groups) == 0 {
		groups[""] = &group{dims: map[string]string{}}
		order = append(order, "")
	}
	sort.SliceStable(order, func(i, j int) bool { return groups[order[i]].n > groups[order[j]].n })
	if q.Limit > 0 && len(order) > q.Limit {
		order = order[:q.Limit]
	}
	out := []map[string]any{}
	for _, k := range order {
		g := groups[k]
		row := map[string]any{cube + "." + measure: strconv.Itoa(g.n)}
		for d, v := range g.dims {
			row[d] = v
		}
		out = append(out, row)
	}
	b, _ := json.Marshal(map[string]any{"result": map[string]any{"data": out}})
	_, _ = w.Write(b)
}

var fakeClause = regexp.MustCompile(`^([a-z_.]+)\s*(<=|>=|==|<|>)\s*(.+)$`)

var fakeDiscoverer = map[string]string{"AWS": "Amazon Web Services", "Azure": "Microsoft Azure", "GCP": "Google Cloud Platform"}

func (f *visTenant) subnets(t *testing.T, w http.ResponseWriter, r *http.Request) {
	filter := r.URL.Query().Get("_filter")
	tfilter := r.URL.Query().Get("_tfilter")
	var rows []map[string]any
	for i, sn := range f.Subnets {
		if !fakeSubnetMatches(t, sn, filter, tfilter) {
			continue
		}
		row := map[string]any{"id": "subnet/" + strconv.Itoa(i), "cidr": sn.CIDR,
			"utilization": map[string]any{"utilization": sn.Util}, "tags": map[string]any{}}
		if sn.Cloud != "" && sn.Only != "disc" {
			row["tags"] = map[string]any{"external_provider/" + strings.ToLower(sn.Cloud): "x"}
		}
		if sn.Cloud != "" && sn.Only != "tag" {
			row["discovery_metadata"] = map[string]any{"discoverer": fakeDiscoverer[sn.Cloud]}
		}
		rows = append(rows, row)
	}
	n := len(rows)
	off, _ := strconv.Atoi(r.URL.Query().Get("_offset"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("_limit"))
	rows = rows[min(off, n):]
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}
	if !strings.Contains(r.URL.Query().Get("_fields"), "tags") {
		rows = nil
	}
	writeResultsWithPage(w, rows, map[string]any{"total_size": strconv.Itoa(n)})
}

func fakeSubnetMatches(t *testing.T, sn fakeSubnet, filter, tfilter string) bool {
	if tfilter != "" {
		ok := false
		for c := range fakeDiscoverer {
			if tfilter == fmt.Sprintf(`"external_provider/%s"~''`, strings.ToLower(c)) {
				ok = sn.Cloud == c && sn.Only != "disc"
			}
		}
		if !ok {
			return false
		}
	}
	if filter == "" {
		return true
	}
	if strings.Contains(filter, " or ") && !strings.HasPrefix(filter, "(") && !strings.Contains(filter, " and ") {
		for _, alt := range strings.Split(filter, " or ") {
			if fakeSubnetMatches(t, sn, alt, "") {
				return true
			}
		}
		return false
	}
	for _, clause := range strings.Split(filter, " and ") {
		// get_subnets' "(cidr<=28 or cidr>=33)" small-link rule: not modelled.
		if strings.HasPrefix(clause, "(") || strings.HasSuffix(clause, ")") {
			continue
		}
		m := fakeClause.FindStringSubmatch(strings.TrimSpace(clause))
		if m == nil {
			t.Errorf("fake tenant: can't read filter clause %q", clause)
			return false
		}
		field, op, val := m[1], m[2], m[3]
		var have int
		switch field {
		case "utilization.utilization":
			have = sn.Util
		case "cidr":
			have = sn.CIDR
		case "discovery_metadata.discoverer":
			want := strings.Trim(val, "'")
			disc := fakeDiscoverer[sn.Cloud]
			if sn.Only == "tag" {
				disc = ""
			}
			if op != "==" || disc != want {
				return false
			}
			continue
		default:
			t.Errorf("fake tenant: field %s", field)
			return false
		}
		want, _ := strconv.Atoi(val)
		ok := map[string]bool{"<": have < want, "<=": have <= want, ">": have > want, ">=": have >= want, "==": have == want}[op]
		if !ok {
			return false
		}
	}
	return true
}

// calls returns the requests made so far whose path and query contain sub.
func (f *visTenant) calls(sub string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.Calls {
		if strings.Contains(c, sub) {
			n++
		}
	}
	return n
}
