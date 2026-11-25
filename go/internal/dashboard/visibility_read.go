package dashboard

// Typed readers for the Visibility Assessment tools (risky_dns_records,
// asset_problems, cmdb_gap, get_subnets by_cloud, visibility_counts).
//
// Every number here can end up as a dollar figure in front of a customer, so a
// reader never turns "couldn't tell" into 0. Each result is a Metric that keeps
// five outcomes apart:
//
//	ok          a whole number Infoblox answered with (0 included)
//	unknown     the read failed, timed out, or answered with no data
//	forbidden   Infoblox refused the read (401 or 403)
//	incomplete  the answer was cut short, so a count would be too low
//	not_read    nothing this app reads can prove it (a Portal definition
//	            that is not confirmed); Reason says where to read it instead
//
// Every Cube.js read goes through strictCubeRows, because Cube.js can answer
// HTTP 200 with {"error":"Continue wait"}, which cubeData would read as zero
// rows. Every read takes the caller's context, so the AI loop's deadline stops
// it, retry included.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"bloxsmith/internal/rest"
)

const (
	MetricOK         = "ok"
	MetricUnknown    = "unknown"
	MetricForbidden  = "forbidden"
	MetricIncomplete = "incomplete"
	MetricNotRead    = "not_read"
)

// Metric is one count and how far it can be trusted. Count is nil unless
// Status is ok.
type Metric struct {
	Count  *int   `json:"count"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

func metricOK(n int) Metric { return Metric{Count: &n, Status: MetricOK} }

func metricFail(status, reason string) Metric { return Metric{Status: status, Reason: reason} }

// OK says whether the count can be used.
func (m Metric) OK() bool { return m.Status == MetricOK && m.Count != nil }

// N is the count, or 0 when there is none; check OK first.
func (m Metric) N() int {
	if m.Count == nil {
		return 0
	}
	return *m.Count
}

// reasonTimeUp is the reason for a read the time budget stopped.
const reasonTimeUp = "Bloxsmith's time limit ran out before Infoblox answered."

// readFailure turns a failed read into a Metric. A read the caller's deadline
// stopped says so, so "time ran out" never reads as "Infoblox is down".
func readFailure(ctx context.Context, status int, err error) Metric {
	if ctx.Err() != nil {
		return metricFail(MetricUnknown, reasonTimeUp)
	}
	var ue *rest.UpstreamError
	if errors.As(err, &ue) {
		status = ue.Status
	}
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return metricFail(MetricForbidden, fmt.Sprintf("Infoblox refused the read (HTTP %d). The API key's user may lack access to this data.", status))
	case status >= 400:
		return metricFail(MetricUnknown, fmt.Sprintf("Infoblox returned an error (HTTP %d).", status))
	}
	return metricFail(MetricUnknown, "Couldn't reach Infoblox.")
}

// cubeReadCtx runs one Cube.js query on the main cube service. rows is nil
// and the Metric says why when there is no usable answer; a real empty answer
// is a non-nil empty slice. Field names come back without the cube prefix.
func (s *Service) cubeReadCtx(ctx context.Context, query map[string]any) ([]map[string]any, Metric) {
	if ctx.Err() != nil {
		return nil, metricFail(MetricUnknown, reasonTimeUp)
	}
	q, _ := json.Marshal(query)
	body, st, err := s.Rest.GetExCtx(ctx, cubeEndpoint, map[string]string{"query": string(q)})
	if errored(st, err) {
		return nil, readFailure(ctx, st, err)
	}
	rows := strictCubeRows(body)
	if rows == nil {
		return nil, metricFail(MetricUnknown, "Infoblox's data service gave no finished answer (it may still have been working).")
	}
	return rows, Metric{Status: MetricOK}
}

// cubeCountCtx runs a count query and adds up measure over every row it
// returns (one row when the query has no dimensions). No rows is a real 0. A
// row whose count is missing or not a whole number makes the count unknown.
func (s *Service) cubeCountCtx(ctx context.Context, query map[string]any, measure string) Metric {
	rows, m := s.cubeReadCtx(ctx, query)
	if rows == nil {
		return m
	}
	total := 0
	for _, r := range rows {
		n, ok := comboCount(r[measure])
		if !ok {
			return metricFail(MetricUnknown, "Infoblox sent a count this app could not read.")
		}
		total += n
	}
	return metricOK(total)
}

// restCountCtx asks a REST list for its server-side total with one row, so a
// count never depends on how many rows one read can hold.
func (s *Service) restCountCtx(ctx context.Context, path string, params map[string]string) Metric {
	if ctx.Err() != nil {
		return metricFail(MetricUnknown, reasonTimeUp)
	}
	p := map[string]string{"_limit": "1", "_fields": "id", "_is_total_size_needed": "true"}
	for k, v := range params {
		p[k] = v
	}
	_, body, err := s.Rest.GetPageStrictCtx(ctx, path, p)
	if err != nil {
		return readFailure(ctx, 0, err)
	}
	n := pageTotalSize(body, -1)
	if n < 0 {
		return metricFail(MetricUnknown, "Infoblox didn't send a total for this list.")
	}
	return metricOK(n)
}

// --- Risky DNS records: the one shared reader ------------------------------
//
// Best practices and the Visibility Assessment both read the flagged records
// through readDNSFlag. The count is its own aggregate query (uniqueRecordCount
// with no dimensions, added up over whatever rows come back), so it does not
// depend on how many sample rows one read may hold. On the live demo tenant on
// 2026-11-25 the aggregate gave Dangling 79, Abandoned 66, Untrusted 106,
// Stale 659, the same as uniqueRecordCount grouped by indicator_ids_str.

// dnsFlagRead is one flag's count and, when asked for, a sample of records.
type dnsFlagRead struct {
	Count    Metric
	Sample   []map[string]any // prefix-stripped cube rows, zone then name order
	SampleOK bool             // the sample read worked (it may still be cut short)
}

func dnsFlagFilter(flag string) []map[string]any {
	return []map[string]any{{
		"member": dnsRecCube + ".indicator_ids_str", "operator": "contains",
		"values": []string{"'" + flag + "'"},
	}}
}

// readDNSFlag reads one flag's aggregate count and, when sampleLimit > 0, up
// to sampleLimit records, the two reads side by side.
func (s *Service) readDNSFlag(ctx context.Context, flag string, sampleLimit int) dnsFlagRead {
	d := func(n string) string { return dnsRecCube + "." + n }
	var out dnsFlagRead
	tasks := []func(){func() {
		out.Count = s.cubeCountCtx(ctx, map[string]any{
			"measures": []string{d("uniqueRecordCount")},
			"filters":  dnsFlagFilter(flag),
		}, "uniqueRecordCount")
	}}
	if sampleLimit > 0 {
		tasks = append(tasks, func() {
			rows, _ := s.cubeReadCtx(ctx, map[string]any{
				"measures": []string{d("uniqueRecordCount")},
				"dimensions": []string{
					d("record_asset_name"), d("record_asset_record_type"),
					d("record_asset_absolute_zone_name"), d("record_asset_zone_id"),
					d("record_asset_dns_rdata"), d("record_asset_last_queried_str"),
				},
				"filters": dnsFlagFilter(flag),
				"order":   map[string]any{d("record_asset_absolute_zone_name"): "asc", d("record_asset_name"): "asc"},
				"limit":   sampleLimit,
			})
			out.Sample, out.SampleOK = rows, rows != nil
		})
	}
	mustFanOut(tasks...)
	return out
}

// dnsKnownFlags are the flags the assessment names. Any other flag value the
// cube holds is reported, never counted as "other high-risk" on a guess.
var dnsKnownFlags = []string{"Dangling", "Abandoned", "Untrusted", "Stale"}

// dnsFlagComboLimit caps the grouped read of flag combinations. A reply this
// long may be cut short.
const dnsFlagComboLimit = 500

// readDNSOtherFlags lists every flag the cube holds that is not one of
// dnsKnownFlags, with how many records carry it. ok is false when the list
// could not be read whole.
func (s *Service) readDNSOtherFlags(ctx context.Context) (other map[string]int, m Metric) {
	rows, m := s.cubeReadCtx(ctx, map[string]any{
		"measures":   []string{dnsRecCube + ".uniqueRecordCount"},
		"dimensions": []string{dnsRecCube + ".indicator_ids_str"},
		"limit":      dnsFlagComboLimit,
	})
	if rows == nil {
		return nil, m
	}
	if len(rows) >= dnsFlagComboLimit {
		return nil, metricFail(MetricIncomplete, "There were more combinations of DNS record flags than this app reads at once.")
	}
	other = map[string]int{}
	for _, r := range rows {
		n, ok := comboCount(r["uniqueRecordCount"])
		if !ok {
			return nil, metricFail(MetricUnknown, "Infoblox sent a count this app could not read.")
		}
		for _, f := range parseFlagList(getStr(r["indicator_ids_str"])) {
			known := false
			for _, k := range dnsKnownFlags {
				if f == k {
					known = true
				}
			}
			if !known {
				other[f] += n
			}
		}
	}
	return other, metricOK(len(other))
}

// parseFlagList reads indicator_ids_str, a bracketed list of single-quoted
// names such as ['Abandoned','Untrusted'].
func parseFlagList(s string) []string {
	var out []string
	cur, in := []rune{}, false
	for _, r := range s {
		switch {
		case r == '\'':
			if in {
				out = append(out, string(cur))
				cur = cur[:0]
			}
			in = !in
		case in:
			cur = append(cur, r)
		}
	}
	return out
}
