package dashboard

// Cube names Infoblox has moved to a successor, kept in one place.
//
// Infoblox marks a retiring cube in its /meta (meta.deprecated,
// lifecycleStage, successor, sunsetDate). A cube is switched only when its
// successor has every member Bloxsmith queries, with the same type and
// description, AND answers Bloxsmith's own queries with the same numbers.
// Checked 2026-11-10 against /api/cubejs/v1/meta and
// /api/cubejs-security/v1/meta, and by live read-only queries on the tenant.
//
//	Old cube -> successor (sunset)          Members Bloxsmith queries                 In successor, same type?       Decision
//	NetworkNstarDhcpLeaseActivity           total_count, lease_op, timestamp          all 3, same type and text      SWITCH. Same numbers hour by
//	  -> DhcpLeaseActivityV1 (2027-10-01)                                                                            hour and day by day, 4-5 Nov.
//	HostMetrics -> HostMetricsV1            avg_value, host, metric_name,             all 5, same type and text      HOLD. timestamp is shifted: V1's
//	  (2027-07-01)                          metric_name_label, timestamp                                             hour h equals the old hour h+1
//	                                                                                                                 (4 Nov, every hour), so the
//	                                                                                                                 DNS query-rate chart would move
//	                                                                                                                 by an hour. Per-host values match.
//	AssetDetails_ch_agg                     assetsCount, cqid, name, taxonomy_type_   name MISSING (V1 has only      HOLD. Also: V1 refuses a query
//	  -> AssetDetailsAggV1 (2027-07-23)     label, providers_label, vendor,            assetName; on the old cube    with no time range ("requires a
//	                                        last_seen, os, ip_addresses,              name == assetName on all      bounded time range"), and every
//	                                        mac_addresses, model, location,           2,202 rows). The other 20     asset count here has none.
//	                                        first_seen, taxonomy_super_category_      are present, same type.
//	                                        label, os_type, provider_label,
//	                                        deploymentContext, region_label,
//	                                        insight_classifications_label,
//	                                        insight_indicators_label
//	AssetDiscoveryStatus                    count                                     count MISSING (V1 has          HOLD. V1 also needs a bounded
//	  -> AssetDiscoveryStatusV1 (2027-07-23)                                          rowCount, same text)           time range; the tile sends none.
//	AssetInsight -> AssetInsightV1          count                                     present, same type and text    HOLD. V1 answers 400 "requires a
//	  (2027-07-23)                                                                                                   bounded time range"; the tile
//	                                                                                                                 sends none.
//	IqActions -> ActionsV1 (2027-07-01)     count, display_id, type, title,           count MISSING (V1 has          HOLD. action_count gave the same
//	                                        severity, status, created_on,             action_count); the 7 dims      228 as count; descriptions of
//	                                        resolved_on                               are present, same type         the dims were reworded.
//	PortunusAggThreat_ch (security service) requests, action, timestamp, tclass,      no successor on the security   HOLD. Retiring only on the main
//	  -> none there; ThreatAggV1 on the     policy_name, severity                     service (ThreatAggV1 is not    service (sunset 2028-09-25),
//	  main service                                                                    listed there)                  which Bloxsmith does not query.
//	TokenUtilProtoSrvIQMonthly              tokens, category, timestamp               no lifecycle marks, no         NOT RETIRING. No change.
//	                                                                                  successor
const (
	cubeDHCP = "DhcpLeaseActivityV1"
)
