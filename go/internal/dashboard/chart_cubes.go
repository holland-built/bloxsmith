package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/cache"
)

// "Chart other Infoblox data": the Build a chart page's second picker, for any
// data set (Cube.js cube) the tenant lists, beside the fixed menus of
// ChartOptions. The list comes from Infoblox's own catalog (/meta), which is
// about 8.5 MB and takes seconds to send, so it is fetched once per hour per
// account, trimmed to what the picker shows, and only the trimmed copy ever
// reaches the screen. The same trimmed copy is the allow-list a query is
// checked against: a cube, count or field the catalog does not list is
// refused before anything is sent.

const (
	cubeMetaPath         = "/api/cubejs/v1/meta"
	cubeSecurityMetaPath = "/api/cubejs-security/v1/meta"
	// cubeCatalogTTL: the catalog changes with Infoblox releases, not by the
	// minute, and a fetch costs about 3.7 s (measured 2026-11-10).
	cubeCatalogTTL = time.Hour
)

// CubeMember is one count (measure) or field (dimension) of a data set.
type CubeMember struct {
	Name  string `json:"name"`
	Title string `json:"title"`
	Type  string `json:"type"`
}

// CatalogCube is one data set as the picker sees it.
type CatalogCube struct {
	Name        string       `json:"name"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Measures    []CubeMember `json:"measures"`
	Dimensions  []CubeMember `json:"dimensions"`
	// endpoint is the query service that listed it.
	endpoint string
}

// CubeCatalog is the trimmed catalog: every data set that can be charted.
type CubeCatalog struct {
	Cubes  []CatalogCube
	byName map[string]int
}

// Cube is the named data set, or false.
func (c *CubeCatalog) Cube(name string) (CatalogCube, bool) {
	i, ok := c.byName[name]
	if !ok {
		return CatalogCube{}, false
	}
	return c.Cubes[i], true
}

// deprecated reads Infoblox's lifecycle marks on a cube or a member: meta.
// deprecated true, or meta.lifecycleStage "deprecated". Such a cube has a
// named successor and a sunset date, and the successor is listed too.
func deprecated(m map[string]any) bool {
	meta := asMap(m["meta"])
	return meta["deprecated"] == true || meta["lifecycleStage"] == "deprecated"
}

// trimCubeMeta keeps what the picker needs from one /meta answer: each
// current cube's name, title and description, and its counts and fields with
// name, plain title and type. Deprecated cubes and members, hidden members,
// and cubes with nothing to count are left out.
func trimCubeMeta(body any, endpoint string) []CatalogCube {
	members := func(xs any) []CubeMember {
		out := []CubeMember{}
		for _, x := range asSlice(xs) {
			m := asMap(x)
			name, _ := m["name"].(string)
			if name == "" || deprecated(m) || m["isVisible"] == false || m["public"] == false {
				continue
			}
			title, _ := m["shortTitle"].(string)
			if title == "" {
				title, _ = m["title"].(string)
			}
			typ, _ := m["type"].(string)
			out = append(out, CubeMember{Name: name, Title: title, Type: typ})
		}
		return out
	}
	var out []CatalogCube
	for _, x := range asSlice(asMap(asMap(body)["result"])["cubes"]) {
		c := asMap(x)
		name, _ := c["name"].(string)
		if name == "" || deprecated(c) || c["isVisible"] == false || c["public"] == false {
			continue
		}
		cube := CatalogCube{Name: name, Measures: members(c["measures"]), Dimensions: members(c["dimensions"]), endpoint: endpoint}
		if len(cube.Measures) == 0 {
			continue
		}
		cube.Title, _ = c["title"].(string)
		if cube.Title == "" {
			cube.Title = name
		}
		cube.Description, _ = c["description"].(string)
		out = append(out, cube)
	}
	return out
}

// newCubeCatalog joins the security service's cubes and the main service's.
// The security service is first: every cube it lists is listed by the main
// service too (21 of 21 on 2026-11-10), and the chart page already asks the
// security service for its threat cube (cubeSecurityEndpoint), so a name in
// both is queried there.
func newCubeCatalog(security, main []CatalogCube) *CubeCatalog {
	c := &CubeCatalog{byName: map[string]int{}}
	for _, cube := range append(slices.Clone(security), main...) {
		if _, dup := c.byName[cube.Name]; dup {
			continue
		}
		c.byName[cube.Name] = len(c.Cubes)
		c.Cubes = append(c.Cubes, cube)
	}
	slices.SortStableFunc(c.Cubes, func(a, b CatalogCube) int {
		return strings.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title))
	})
	for i, cube := range c.Cubes {
		c.byName[cube.Name] = i
	}
	return c
}

// catalogStore holds one catalog per key for a TTL, and lets only one fetch
// per key run at a time: callers that arrive while it runs wait and share its
// answer. A failed fetch is not kept, so the next caller tries again.
type catalogStore struct {
	ttl     time.Duration
	now     func() time.Time
	mu      sync.Mutex
	entries map[string]catalogEntry
	flights map[string]*catalogFlight
}

type catalogEntry struct {
	cat *CubeCatalog
	at  time.Time
}

type catalogFlight struct {
	wg  sync.WaitGroup
	cat *CubeCatalog
	err error
}

func newCatalogStore(ttl time.Duration) *catalogStore {
	return &catalogStore{ttl: ttl, now: time.Now, entries: map[string]catalogEntry{}, flights: map[string]*catalogFlight{}}
}

func (st *catalogStore) get(key string, fetch func() (*CubeCatalog, error)) (*CubeCatalog, error) {
	st.mu.Lock()
	if e, ok := st.entries[key]; ok && st.now().Sub(e.at) < st.ttl {
		st.mu.Unlock()
		return e.cat, nil
	}
	if f, ok := st.flights[key]; ok {
		st.mu.Unlock()
		f.wg.Wait()
		return f.cat, f.err
	}
	f := &catalogFlight{}
	f.wg.Add(1)
	st.flights[key] = f
	st.mu.Unlock()

	defer func() {
		st.mu.Lock()
		delete(st.flights, key)
		if f.err == nil && f.cat != nil {
			// One account's catalog at a time: an older key belongs to an
			// account this app has switched away from.
			clear(st.entries)
			st.entries[key] = catalogEntry{cat: f.cat, at: st.now()}
		}
		st.mu.Unlock()
		f.wg.Done()
	}()
	// Set first, so a fetch that panics leaves its waiters an error, not nil.
	f.err = fmt.Errorf("the catalog fetch did not finish")
	f.cat, f.err = fetch()
	if f.err == nil && f.cat == nil {
		f.err = fmt.Errorf("no catalog")
	}
	return f.cat, f.err
}

var cubeCatalogs = newCatalogStore(cubeCatalogTTL)

// CubeCatalog is the tenant's trimmed catalog, from the store when fresh. The
// key carries the cache generation, which an account switch bumps, so another
// account never sees this one's list.
func (s *Service) CubeCatalog() (*CubeCatalog, error) {
	var gen uint64
	if s.Cache != nil {
		gen = s.Cache.Gen()
	}
	key := s.Rest.BaseURL() + "|" + strconv.FormatUint(gen, 10)
	return cubeCatalogs.get(key, func() (*CubeCatalog, error) {
		var lists [2][]CatalogCube
		for i, src := range []struct{ meta, query string }{
			{cubeSecurityMetaPath, cubeSecurityEndpoint},
			{cubeMetaPath, cubeEndpoint},
		} {
			body, st, err := s.Rest.GetEx(src.meta, nil)
			if errored(st, err) {
				return nil, fmt.Errorf("%s: status %d: %v", src.meta, st, err)
			}
			// A 200 without a cubes array (missing, null, an object) is a
			// broken answer: trimmed, it would be an empty list kept for an
			// hour, and the picker would say there is nothing to chart.
			if _, ok := asMap(asMap(body)["result"])["cubes"].([]any); !ok {
				return nil, fmt.Errorf("%s: the answer has no cubes list", src.meta)
			}
			lists[i] = trimCubeMeta(body, src.query)
		}
		return newCubeCatalog(lists[0], lists[1]), nil
	})
}

// catalogUnavailable is what the screen gets when the catalog could not be
// fetched: an error, never an empty list that would read as "no data".
func catalogUnavailable() map[string]any {
	return map[string]any{"status": "error", "reason": "Infoblox didn't send its list of data."}
}

// CubeList is GET /api/chart/cubes: every data set's name, title and
// description, without their fields (those come one data set at a time).
func (s *Service) CubeList() map[string]any {
	cat, err := s.CubeCatalog()
	if err != nil {
		return catalogUnavailable()
	}
	out := make([]map[string]string, 0, len(cat.Cubes))
	for _, c := range cat.Cubes {
		out = append(out, map[string]string{"name": c.Name, "title": c.Title, "description": c.Description})
	}
	return map[string]any{"status": "ok", "cubes": out}
}

// CubeFields is GET /api/chart/fields?cube=: one data set with its counts and
// fields. status "invalid" is a name the catalog does not list.
func (s *Service) CubeFields(name string) map[string]any {
	cat, err := s.CubeCatalog()
	if err != nil {
		return catalogUnavailable()
	}
	c, ok := cat.Cube(name)
	if !ok {
		return map[string]any{"status": "invalid"}
	}
	return map[string]any{"status": "ok", "cube": c}
}

// AnyPicks is one chart of any data set: a count, an optional field to split
// by (with a top N), and an optional window on one of its date fields.
type AnyPicks struct {
	Cube, Measure, Split, Time, Window string
	Top                                int
}

// BuildQuery checks every name in the picks against the catalog and builds the
// Cube.js query and the service to send it to. Nothing outside the catalog
// and the page's own window and top-N menus gets through.
func (c *CubeCatalog) BuildQuery(p AnyPicks) (map[string]any, string, error) {
	bad := fmt.Errorf("that data isn't available to chart")
	cube, ok := c.Cube(p.Cube)
	if !ok {
		return nil, "", bad
	}
	member := func(xs []CubeMember, name string) (CubeMember, bool) {
		for _, x := range xs {
			if x.Name == name {
				return x, true
			}
		}
		return CubeMember{}, false
	}
	if _, ok := member(cube.Measures, p.Measure); !ok {
		return nil, "", bad
	}
	q := map[string]any{"measures": []string{p.Measure}}
	if p.Split != "" {
		d, ok := member(cube.Dimensions, p.Split)
		if !ok || d.Type == "time" || !slices.Contains(chartCatalog.Tops, p.Top) {
			return nil, "", bad
		}
		q["dimensions"] = []string{p.Split}
		q["order"] = map[string]any{p.Measure: "desc"}
		q["limit"] = p.Top
	} else if p.Top != 0 {
		return nil, "", bad
	}
	if p.Time != "" || p.Window != "" {
		d, ok := member(cube.Dimensions, p.Time)
		w, okW := findChoice(chartCatalog.Windows, p.Window)
		if !ok || d.Type != "time" || !okW || w.Value == "" {
			return nil, "", bad
		}
		q["timeDimensions"] = []map[string]any{{"dimension": p.Time, "dateRange": w.Value}}
	}
	return q, cube.endpoint, nil
}

// RunAnyChart checks the picks against the catalog, then runs the query the
// way RunChart does, with the same ok / empty / error / invalid statuses.
func (s *Service) RunAnyChart(ctx context.Context, p AnyPicks) map[string]any {
	cat, err := s.CubeCatalog()
	if err != nil {
		return catalogUnavailable()
	}
	q, endpoint, err := cat.BuildQuery(p)
	if err != nil {
		return map[string]any{"status": "invalid", "reason": err.Error()}
	}
	qj, _ := json.Marshal(q)
	ck := cache.Key("chartany", endpoint, map[string]string{"query": string(qj)}, false)
	if v, ok := s.Cache.Get(ck); ok {
		return v.(map[string]any)
	}
	g := s.Cache.Gen()
	body, st, err := s.Rest.GetEx(endpoint, map[string]string{"query": string(qj)})
	if errored(st, err) {
		return map[string]any{
			"query": q, "endpoint": endpoint, "rows": []map[string]any{},
			"status": "error", "reason": "Infoblox didn't answer this query (upstream error).",
		}
	}
	raw := cubeData(body)
	rows := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		rows = append(rows, asMap(r))
	}
	status := "ok"
	if len(rows) == 0 {
		status = "empty"
	}
	result := map[string]any{"query": q, "endpoint": endpoint, "rows": rows, "status": status}
	s.Cache.SetGen(ck, result, g)
	return result
}
