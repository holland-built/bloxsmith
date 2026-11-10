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
//	AssetDetails_ch_agg                     assetsCount, cqid, name, taxonomy_type_    HOLD. V1 answers 400 to any query
//	  -> AssetDetailsAggV1 (2027-07-23)     label, providers_label, vendor,            without a time range, and to any range
//	                                        last_seen, os, ip_addresses, ...           over 400 days: ["2000-01-01",
//	    "2100-01-01"], an inDateRange or afterDate filter in place of a timeDimension, and
//	    ["2025-10-06","2026-11-10"] are all refused "exceeds the maximum time range of 400 days";
//	    ["2025-10-07","2026-11-10"] is the widest accepted. So V1 cannot count a record whose time is
//	    more than 400 days back, which the old cube counts, and any bound is a silent cutoff later. What
//	    did match, for the record: with updated_at in "from 365 days ago to now", 2,200 assets on both;
//	    name -> assetName equal on every row; 53 Assets-tab reads and 114 asset charts identical once
//	    sorts end on a tie-breaker (V1 orders tied rows differently). Latency median of 4: old 317 ms,
//	    V1 339 ms. Revisit if Infoblox lifts the 400-day cap or adds an unbounded current-state cube.
//	AssetDiscoveryStatus                    count                                      HOLD, same 400-day cap. V1 has
//	  -> AssetDiscoveryStatusV1 (2027-07-23)                                           rowCount for count; on updated_at,
//	    last 365 days: 16,505 on both. Old 335 ms, V1 373 ms.
//	AssetInsight -> AssetInsightV1          count                                      HOLD, same 400-day cap. On
//	  (2027-07-23)                                                                     evaluation_time, last 365 days:
//	    2,954 on both (sync_time differed: old 1,975, V1 2,954). Old 483 ms, V1 290 ms.
//	PortunusAggThreat_ch (security service) requests, action, timestamp, tclass,       HOLD. No successor on the security
//	  -> none there; ThreatAggV1 on the     policy_name, severity                      service. Retiring only on the main
//	  main service                                                                     service (sunset 2028-09-25).
//	TokenUtilProtoSrvIQMonthly              tokens, category, timestamp                NOT RETIRING. No change.
const (
	cubeDHCP    = "DhcpLeaseActivityV1"
	cubeHost    = "HostMetricsV1"
	cubeActions = "ActionsV1"
	// Held on the old name (see the table): one row per asset Infoblox holds now.
	cubeAssets = "AssetDetails_ch_agg"
)

// hostTier is the filter that makes HostMetricsV1 read the stored rows of
// step ("hour" or "day"), as the old cube did when asked for that step.
func hostTier(step string) map[string]any {
	return map[string]any{"member": cubeHost + ".granularity", "operator": "equals", "values": []string{step}}
}
