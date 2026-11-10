package dashboard

// Cube names Infoblox has moved to a successor, kept in one place.
//
// Infoblox marks a retiring cube in its /meta (meta.deprecated,
// lifecycleStage, successor, sunsetDate). A cube is switched only when its
// successor has every member Bloxsmith queries (or a renamed one that returned
// the same values), AND answers Bloxsmith's own queries with the same numbers.
// Checked 2026-11-10 against /api/cubejs/v1/meta and
// /api/cubejs-security/v1/meta, and by live read-only queries on the tenant.
//
//	Old cube -> successor (sunset)          What Bloxsmith queries                     Decision and evidence (live, 2026-11-10)
//	NetworkNstarDhcpLeaseActivity           total_count, lease_op, timestamp           SWITCHED earlier. Same numbers hour by
//	  -> DhcpLeaseActivityV1 (2027-10-01)                                              hour and day by day, 4-5 Nov.
//	HostMetrics -> HostMetricsV1            avg_value, host, metric_name,              SWITCHED, with one adaptation. The
//	  (2027-07-01)                          metric_name_label, granularity,            "hour shift" was not a relabelled
//	                                        timestamp                                  timestamp. Both cubes hold the same
//	    rows at three stored steps (granularity "minute" = one row per 5 minutes, "hour", "day"; the raw
//	    rows of 9-10 Nov were identical). The old cube reads the stored step a query asks for; V1 picks the
//	    step from the length of the range, so over "last 24 hours" it averaged 5-minute rows into
//	    [h, h+1) while the old cube returned the stored hour rows, which cover (h-1, h]. Hence "V1 hour h ~
//	    old hour h+1", off by one 5-minute sample at each edge. V1 also served day rows for an 8-day range
//	    asked "by hour". Fix: a query drawn by hour or by day also filters granularity = that step
//	    (hostTier). With it, every DNS query-rate chart matched exactly: last 24 hours and today by hour
//	    (24/24, 18/18 rows, 3 of 3 runs), 7 days / 30 days / this month / last month by day (7, 30, 11, 31
//	    rows), and the one-total charts for every window. One totals need no filter: both cubes pick the
//	    same step. "This month" took a repeat read to match: it moves between any two reads, old cube
//	    against itself too. The per-host CPU and memory reads (no time range: latest sample per host) matched on
//	    61-62 hosts in 5 of 6 paired runs; the sixth differed on hosts that reported between the two calls.
//	IqActions -> ActionsV1 (2027-07-01)     count -> action_count; display_id, type,   SWITCHED. Summary: 31 groups, 229 actions
//	                                        title, severity, status, created_on,       on both. Monthly: 8 months, 219, every
//	                                        resolved_on                                month equal. Recent: 229 rows identical,
//	                                                                                   same order.
//	AssetDetails_ch_agg                     assetsCount; name -> assetName; cqid,      SWITCHED, with two adaptations. V1
//	  -> AssetDetailsAggV1 (2027-07-23)     taxonomy_type_label, providers_label,      refuses a query with no time range
//	                                        vendor, last_seen, os, ip_addresses,       ("requires a bounded time range") or
//	                                        mac_addresses, model, location,            one over 400 days. Every row carries
//	                                        first_seen, and the chart fields           updated_at, the oldest on 10 Aug (92
//	    days back), so snapshotWindow (updated_at, the last 365 days up to now) counts every asset: 2,200 on
//	    both. Second, V1 breaks ties in a sort differently, so the same page held different assets that
//	    shared a last_seen; the old cube was stable but arbitrary. Every sort now ends on a tie-breaker
//	    (cqid for the list, the field itself for a top N), and with it on both cubes all 53 Assets-tab
//	    queries (list pages at 3 offsets x 5 sorts x 2 directions, searches, type filters, the type
//	    chips, 8 detail reads) and all 114 asset charts (50 "now", 64 "new assets" by first_seen, whose
//	    own range is enough) returned identical rows.
//	AssetDiscoveryStatus                    count -> rowCount                          SWITCHED. Needs a time range too;
//	  -> AssetDiscoveryStatusV1 (2027-07-23)                                           updated_at all within 92 days,
//	                                                                                   none blank. 16,505 on both.
//	AssetInsight -> AssetInsightV1          count                                      SWITCHED. Needs a time range;
//	  (2027-07-23)                                                                     evaluation_time (oldest 27 Oct) gives
//	    2,954 on both. Not sync_time: on that field the old cube gave 1,975 and V1 2,954, so the field
//	    means something different between them. Paired runs of both tiles matched 4 of 6 times; the two
//	    misses were the old cube changing (16,508 and 2,942 once each), and 8 repeat reads of each were
//	    then steady on both.
//	PortunusAggThreat_ch (security service) requests, action, timestamp, tclass,       HOLD. No successor on the security
//	  -> none there; ThreatAggV1 on the     policy_name, severity                      service. Retiring only on the main
//	  main service                                                                     service (sunset 2028-09-25).
//	TokenUtilProtoSrvIQMonthly              tokens, category, timestamp                NOT RETIRING. No change.
//
// The time-bounded V1 queries go only to the Cube.js endpoint
// (QueryCubeDirectOnlyErr), never to the MCP fallback: its query_cube tool
// cuts a range to 30 days (threatintel.go), which would quietly count fewer
// assets.
const (
	cubeDHCP      = "DhcpLeaseActivityV1"
	cubeHost      = "HostMetricsV1"
	cubeActions   = "ActionsV1"
	cubeAssets    = "AssetDetailsAggV1"
	cubeDiscovery = "AssetDiscoveryStatusV1"
	cubeInsight   = "AssetInsightV1"
)

// snapshotRange is the time range a V1 snapshot cube must be given. It runs to
// now, and 365 days stays under the 400-day cap while reaching far past the
// oldest row seen (92 days).
const snapshotRange = "from 365 days ago to now"

// snapshotWindow is the time range for a snapshot read on field, fresh each
// call. It is in the Mcp.QueryCube option shape (internal/mcp turns
// time_dimensions into timeDimensions).
func snapshotWindow(field string) []map[string]any {
	return []map[string]any{{"dimension": field, "dateRange": snapshotRange}}
}

// hostTier is the filter that makes HostMetricsV1 read the stored rows of
// step ("hour" or "day"), as the old cube did when asked for that step.
func hostTier(step string) map[string]any {
	return map[string]any{"member": cubeHost + ".granularity", "operator": "equals", "values": []string{step}}
}
