package dashboard

// The server's paged "Show unused networks" list (GET /api/ipam/subnets/unused)
// asks with UnusedSubnetFilter and these two, so its rows match the count in
// _totals.subnetsUnused and have the same shape as the Network table's rows.

// SubnetFields is the field list the dashboard's subnet fetches ask for.
const SubnetFields = subnetFields

// NormSubnets is normSubnets: addr/used/total/util/site/cloud for each row.
func NormSubnets(raw []any) []map[string]any { return normSubnets(raw) }
