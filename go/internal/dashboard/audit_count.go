package dashboard

import (
	"context"
	"errors"
	"strconv"
	"time"

	"bloxsmith/internal/rest"
)

// The Overview's "Changes" line counts the whole last 24 hours of the audit
// log. /api/csp-audit reads only the newest 500 rows, so on a busy tenant its
// window shrinks to fit them (one tenant writes about 24,000 rows a day).
//
// Probed read-only on 2026-11-25: the audit log returns no total for a filter
// ("page" is null, and _count, _total and _is_total_size_needed change
// nothing), and it refuses a _limit over 1000. So the count is made by paging
// with _offset, fetching only the three fields it needs.
const (
	auditCountPage    = 1000             // the most rows one request may ask for
	auditCountCeiling = 50000            // stop here and say "more than"
	auditCountBudget  = 20 * time.Second // stop here too, and say "more than"
	auditCountWorkers = 4                // pages read at the same time
)

type auditPage struct {
	rows []any
	err  error
	code int
}

// CSPAuditCount counts the audit log over the 24 hours before now: every row,
// the rows made by people (the same auditClass rule the Changes tab uses), the
// failed ones and the ones with no result recorded. The upper edge is fixed at
// now, so rows written while it pages cannot shift the offsets.
//
// A read that fails before anything is counted is "status":"error", never a 0.
// When the ceiling or the time budget stops it, "complete" is false and the
// counts are a floor ("more than"); the window is never shortened to fit.
func (s *Service) CSPAuditCount(ctx context.Context, now time.Time) map[string]any {
	until := now.UTC()
	since := until.Add(-24 * time.Hour)
	filter := "created_at>=" + rest.Lit(since.Format(time.RFC3339)) + " and created_at<=" + rest.Lit(until.Format(time.RFC3339))
	bctx, cancel := context.WithTimeout(ctx, auditCountBudget)
	defer cancel()

	out := map[string]any{"status": "ok", "total": 0, "people": 0, "failed": 0, "no_result": 0,
		"complete": true, "since": since.Format(time.RFC3339), "until": until.Format(time.RFC3339), "ceiling": auditCountCeiling}
	total, people, failed, noResult := 0, 0, 0, 0
	fail := func(code int) map[string]any {
		e := map[string]any{"status": "error"}
		if code == 401 || code == 403 {
			e["permission_denied"] = true
		}
		return e
	}

	for off := 0; ; off += auditCountWorkers * auditCountPage {
		pages := make([]auditPage, auditCountWorkers)
		done := make(chan struct{}, auditCountWorkers)
		for i := range pages {
			go func(i int) {
				defer func() { done <- struct{}{} }()
				body, st, err := s.Rest.GetExCtx(bctx, "/api/auditlog/v1/logs", map[string]string{
					"_filter": filter, "_limit": strconv.Itoa(auditCountPage),
					"_offset":   strconv.Itoa(off + i*auditCountPage),
					"_order_by": "created_at desc", "_fields": "user_name,subject_type,http_code",
				})
				if errored(st, err) {
					if err == nil {
						err = errors.New("audit log read failed")
					}
					pages[i] = auditPage{err: err, code: st}
					return
				}
				pages[i] = auditPage{rows: rest.Unwrap(body)}
			}(i)
		}
		for range pages {
			<-done
		}
		for _, p := range pages {
			if p.err != nil {
				// Out of time with something counted: say "more than". A
				// failure, or no time to count anything, is not checked.
				if bctx.Err() != nil && ctx.Err() == nil && total > 0 {
					out["complete"], out["stopped_by"] = false, "time"
					break
				}
				return fail(p.code)
			}
			for _, item := range p.rows {
				l := asMap(item)
				if auditClass(getStr(l["user_name"]), getStr(l["subject_type"])) == "person" {
					people++
				}
				switch {
				case !isDigit(l["http_code"]):
					noResult++
				case toInt(l["http_code"]) >= 400:
					failed++
				}
			}
			total += len(p.rows)
			if len(p.rows) < auditCountPage {
				break
			}
			if total >= auditCountCeiling {
				out["complete"], out["stopped_by"] = false, "ceiling"
				break
			}
		}
		last := pages[len(pages)-1]
		if out["complete"] == false || last.err != nil || len(last.rows) < auditCountPage {
			break
		}
	}
	out["total"], out["people"], out["failed"], out["no_result"] = total, people, failed, noResult
	return out
}
