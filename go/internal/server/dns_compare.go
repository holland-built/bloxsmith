package server

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"

	"bloxsmith/internal/rest"
)

// dnsZoneCompare serves the DNS tab's "Compare views": the same zone name in
// two DNS views, record by record. Read-only; it changes nothing.
//
//	GET /api/dns/zone-compare?a=dns/auth_zone/<id>&b=dns/auth_zone/<id>
//
// Records are read by zone id, because /dns/record refuses a view== filter
// (live 2026-11-17: "Operation EQ is not allowed for 'view'"). Every page is
// read: the script this came from stopped at 1,000 records without saying so.
// /dns/record sends no total, so paging stops at the first short page, ordered
// by id so pages neither skip nor repeat (checked live 2026-11-17: 3-record
// pages gave the same 8 records, in the same order, as one read).
//
// status is "ok" when both zones were read to the end, "partial" when one
// stopped early (each side's note says where), and "error" when either could
// not be read at all, since there is then nothing to compare.
func (d *Deps) dnsZoneCompare(w http.ResponseWriter, r *http.Request) {
	defer d.recover500(w, r, "/api/dns/zone-compare")
	q := r.URL.Query()
	ids := [2]string{strings.TrimSpace(q.Get("a")), strings.TrimSpace(q.Get("b"))}
	for _, id := range ids {
		if !validZoneID(id) {
			d.json(w, r, 400, map[string]any{"error": "a and b must each be a zone id (dns/auth_zone/...)"})
			return
		}
	}
	if ids[0] == ids[1] {
		d.json(w, r, 400, map[string]any{"error": "pick two different zones"})
		return
	}
	cli := d.restFor(r)
	var sides [2]zoneRead
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sides[i] = readZoneRecords(cli, ids[i])
		}()
	}
	wg.Wait()

	status := "ok"
	for _, s := range sides {
		if s.failed && len(s.recs) == 0 {
			d.json(w, r, 200, map[string]any{"status": "error", "error": s.note, "a": sides[0].summary(), "b": sides[1].summary()})
			return
		}
		if !s.complete {
			status = "partial"
		}
	}
	res := compareRecords(sides[0].recs, sides[1].recs)
	res["status"] = status
	res["a"], res["b"] = sides[0].summary(), sides[1].summary()
	d.json(w, r, 200, res)
}

// validZoneID accepts dns/auth_zone/<id> with nothing that could break out of
// the quoted _filter value.
func validZoneID(id string) bool {
	tail, ok := strings.CutPrefix(id, "dns/auth_zone/")
	return ok && tail != "" && !strings.ContainsAny(tail, `"\/ `) && len(id) < 200
}

// Page size and the most pages read per zone. 50 x 1,000 = 50,000 records; a
// bigger zone is compared on what was read and marked partial.
const (
	comparePageSize = 1000
	comparePageCap  = 50
)

type zoneRec struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Data string `json:"data"`
	TTL  any    `json:"ttl"`
}

type zoneRead struct {
	recs     []zoneRec
	complete bool
	failed   bool
	note     string
}

func (z zoneRead) summary() map[string]any {
	return map[string]any{"records": len(z.recs), "complete": z.complete, "note": z.note}
}

func readZoneRecords(cli *rest.Client, zoneID string) zoneRead {
	var out zoneRead
	for page := 0; page < comparePageCap; page++ {
		rows, err := cli.GetStrict("/api/ddi/v1/dns/record", map[string]string{
			"_filter":   `zone=="` + zoneID + `"`,
			"_fields":   "id,name_in_zone,type,dns_rdata,ttl",
			"_order_by": "id",
			"_limit":    strconv.Itoa(comparePageSize),
			"_offset":   strconv.Itoa(page * comparePageSize),
		})
		if err != nil {
			out.failed = true
			if page == 0 {
				out.note = "Infoblox did not answer when its records were read."
			} else {
				out.note = fmt.Sprintf("Infoblox stopped answering after %s records, so the rest were not compared.", commas(len(out.recs)))
			}
			return out
		}
		for _, ri := range rows {
			m := getMap(ri)
			out.recs = append(out.recs, zoneRec{
				Name: str(m, "name_in_zone"),
				Type: strings.ToUpper(str(m, "type")),
				Data: strings.TrimSpace(str(m, "dns_rdata")),
				TTL:  m["ttl"],
			})
		}
		if len(rows) < comparePageSize {
			out.complete = true
			return out
		}
	}
	out.note = fmt.Sprintf("Stopped after %s records, so the rest were not compared.", commas(len(out.recs)))
	return out
}

// compareRecords lines up two zones by name and type. Names compare without
// case (DNS names are not case-sensitive) and the apex shows as "@".
//   - same name, type, values and TTLs on both sides: counted in "same";
//   - same name and type, but the values or the TTLs differ: one "different"
//     row with both sides' values, and "what" saying "value" or "ttl";
//   - a name and type on one side only: each record in only_a or only_b.
func compareRecords(a, b []zoneRec) map[string]any {
	group := func(recs []zoneRec) (map[string][]zoneRec, []string) {
		g := map[string][]zoneRec{}
		var keys []string
		for _, r := range recs {
			if r.Name == "" || r.Name == "@" {
				r.Name = "@"
			}
			k := strings.ToLower(r.Name) + "\x00" + r.Type
			if _, ok := g[k]; !ok {
				keys = append(keys, k)
			}
			g[k] = append(g[k], r)
		}
		return g, keys
	}
	ga, ka := group(a)
	gb, kb := group(b)
	same := 0
	onlyA, onlyB, different := []zoneRec{}, []zoneRec{}, []map[string]any{}
	for _, k := range ka {
		ra, rb := ga[k], gb[k]
		if rb == nil {
			onlyA = append(onlyA, ra...)
			continue
		}
		values := func(rs []zoneRec) string {
			v := make([]string, len(rs))
			for i, r := range rs {
				v[i] = compareData(r)
			}
			sort.Strings(v)
			return strings.Join(v, "\n")
		}
		ttls := func(rs []zoneRec) string {
			v := make([]string, len(rs))
			for i, r := range rs {
				v[i] = compareData(r) + "\x00" + fmt.Sprint(r.TTL)
			}
			sort.Strings(v)
			return strings.Join(v, "\n")
		}
		switch {
		case values(ra) != values(rb):
			different = append(different, map[string]any{"name": ra[0].Name, "type": ra[0].Type, "what": "value", "a": ra, "b": rb})
		case ttls(ra) != ttls(rb):
			different = append(different, map[string]any{"name": ra[0].Name, "type": ra[0].Type, "what": "ttl", "a": ra, "b": rb})
		default:
			same += len(ra)
		}
	}
	for _, k := range kb {
		if ga[k] == nil {
			onlyB = append(onlyB, gb[k]...)
		}
	}
	return map[string]any{"same": same, "only_a": onlyA, "only_b": onlyB, "different": different}
}

// compareData is the value a record is compared on. For an SOA it leaves out
// the serial (the third field: primary, contact, serial, refresh, retry,
// expire, minimum), because every view keeps its own serial and a serial-only
// difference would flag every zone. The full value is still what is shown.
func compareData(r zoneRec) string {
	if r.Type != "SOA" {
		return r.Data
	}
	f := strings.Fields(r.Data)
	if len(f) != 7 {
		return r.Data
	}
	return strings.Join(append(f[:2:2], f[3:]...), " ")
}
