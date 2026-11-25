package dashboard

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/rest"
)

// The Overview's "Changes" line counts the whole last 24 hours of the audit
// log. /api/csp-audit reads only the newest 500 rows, so on a busy tenant its
// window shrinks to fit them (one tenant writes about 24,000 rows a day).
//
// Probed read-only on 2026-11-25: the audit log returns no total for a filter
// ("page" is null, and _count, _total and _is_total_size_needed change
// nothing), it refuses a _limit over 1000, and _order_by takes one key only
// ("multiple sorting criterias are not allowed"; id is not sortable). So the
// count pages with _offset over created_at desc, with the upper edge of the
// window fixed so rows written meanwhile cannot shift the pages. Timestamps
// carry microseconds; 1,000 live rows had no two alike.
const (
	auditCountPage          = 1000             // the most rows one request may ask for
	auditCountCeiling       = 50000            // stop here
	auditCountBudgetDefault = 20 * time.Second // stop here too
	auditCountWorkers       = 4                // pages read at the same time
)

// auditCountBudget is a variable only so a test can shorten it.
var auditCountBudget = auditCountBudgetDefault

// auditTally is one paged count over a filter.
type auditTally struct {
	total, failed, noResult int
	complete                bool   // every row in the window was read
	more                    bool   // a row past the ceiling was seen
	stoppedBy               string // "ceiling" or "time" when not complete
	failCode                int    // HTTP status, or -1, when the read failed
}

type auditPage struct {
	rows    []any
	code    int  // HTTP status, 0 when none arrived
	timeout bool // no answer before the time budget ran out
	bad     bool // refused, failed, or an answer without a results list
}

// auditResults is the page's rows, or false when the body has no results
// list: a 200 of {} or {"results":null} is not an empty page.
func auditResults(body any) ([]any, bool) {
	m, ok := body.(map[string]any)
	if !ok {
		return nil, false
	}
	rows, ok := m["results"].([]any)
	return rows, ok
}

// CSPAuditCount counts the audit log over the 24 hours before now: every row,
// the failed ones and the ones with no result recorded, and separately the
// rows by people, using the same cspAuditMachine filter as the Changes tab
// (CSPAudit kind=people).
//
// Any refused or failed page makes the count "status":"error", even when the
// time budget also ran out, and never a 0. A count stopped by the time budget
// is "complete":false ("at least"); one stopped at the ceiling is "more":true
// only when a row past it was actually read ("more than").
func (s *Service) CSPAuditCount(ctx context.Context, now time.Time) map[string]any {
	until := now.UTC()
	since := until.Add(-24 * time.Hour)
	window := "created_at>=" + rest.Lit(since.Format(time.RFC3339)) + " and created_at<=" + rest.Lit(until.Format(time.RFC3339))
	people := strings.Join(append([]string{window}, auditKindClauses("people")...), " and ")
	bctx, cancel := context.WithTimeout(ctx, auditCountBudget)
	defer cancel()

	var all, ppl auditTally
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); all = s.countAudit(ctx, bctx, window, "subject_type,http_code", true) }()
	go func() { defer wg.Done(); ppl = s.countAudit(ctx, bctx, people, "user_name", false) }()
	wg.Wait()

	for _, t := range []auditTally{all, ppl} {
		if t.failCode != 0 {
			out := map[string]any{"status": "error"}
			if t.failCode == 401 || t.failCode == 403 {
				out["permission_denied"] = true
			}
			return out
		}
	}
	out := map[string]any{"status": "ok", "total": all.total, "people": ppl.total,
		"people_complete": ppl.complete, "failed": all.failed, "no_result": all.noResult,
		"complete": all.complete, "more": all.more,
		"since": since.Format(time.RFC3339), "until": until.Format(time.RFC3339), "ceiling": auditCountCeiling}
	if !all.complete {
		out["stopped_by"] = all.stoppedBy
	}
	return out
}

// countAudit pages one filter. ctx is the request, bctx the time budget.
func (s *Service) countAudit(ctx, bctx context.Context, filter, fields string, outcomes bool) auditTally {
	get := func(off, limit int) auditPage {
		body, st, err := s.Rest.GetExCtx(bctx, "/api/auditlog/v1/logs", map[string]string{
			"_filter": filter, "_limit": strconv.Itoa(limit), "_offset": strconv.Itoa(off),
			"_order_by": "created_at desc", "_fields": fields,
		})
		if errored(st, err) {
			// Out of time with no answer, while the request itself still wanted one.
			if st == 0 && bctx.Err() != nil && ctx.Err() == nil {
				return auditPage{timeout: true}
			}
			return auditPage{bad: true, code: st}
		}
		rows, ok := auditResults(body)
		if !ok {
			return auditPage{bad: true, code: st}
		}
		return auditPage{rows: rows, code: st}
	}
	failed := func(p auditPage) auditTally {
		if p.code > 0 {
			return auditTally{failCode: p.code}
		}
		return auditTally{failCode: -1}
	}

	var t auditTally
	for off := 0; ; off += auditCountWorkers * auditCountPage {
		pages := make([]auditPage, auditCountWorkers)
		var wg sync.WaitGroup
		for i := range pages {
			wg.Add(1)
			go func(i int) { defer wg.Done(); pages[i] = get(off+i*auditCountPage, auditCountPage) }(i)
		}
		wg.Wait()
		// A refusal or failure on any page wins over a timeout on another.
		for _, p := range pages {
			if p.bad {
				return failed(p)
			}
		}
		for _, p := range pages {
			if p.timeout {
				if t.total == 0 {
					return auditTally{failCode: -1}
				}
				t.stoppedBy = "time"
				return t
			}
			if outcomes {
				for _, item := range p.rows {
					l := asMap(item)
					switch {
					case !isDigit(l["http_code"]):
						t.noResult++
					case toInt(l["http_code"]) >= 400:
						t.failed++
					}
				}
			}
			t.total += len(p.rows)
			if len(p.rows) < auditCountPage {
				t.complete = true
				return t
			}
			if t.total >= auditCountCeiling {
				// Full up to the ceiling: read one row past it to prove more.
				next := get(t.total, 1)
				switch {
				case next.bad:
					return failed(next)
				case next.timeout:
					t.stoppedBy = "time"
				case len(next.rows) == 0:
					t.complete = true
				default:
					t.more, t.stoppedBy = true, "ceiling"
				}
				return t
			}
		}
	}
}
