package dashboard

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// Which public cloud a network or zone came from: "AWS", "Azure", "GCP", or ""
// for anything else (NIOS imports, Microsoft AD, Cloudflare, hand-made rows).
// The second value is a short hover line naming the account where the tags
// carry one: the Azure subscription and resource group, the GCP project. AWS
// tags carry no account number, so AWS gets the zone or hosted zone instead.
//
// Read from tag shapes measured on the live tenant 2026-11-17. The
// external_provider tags' provider_id values are discovery-job ids, the same
// family auditClass treats as service noise; nothing here changes that.

// cloudOfSubnet reads a raw ipam/subnet row. Discovered subnets carry
// external_provider/<aws|azure|gcp> plus discovery_<cloud>/* tags, and
// discovery_metadata.discoverer names the cloud in words.
func cloudOfSubnet(s map[string]any) (string, string) {
	tags := asMap(s["tags"])
	dm := asMap(s["discovery_metadata"])
	cloud := ""
	switch {
	case hasKey(tags, "external_provider/aws"):
		cloud = "AWS"
	case hasKey(tags, "external_provider/azure"):
		cloud = "Azure"
	case hasKey(tags, "external_provider/gcp"):
		cloud = "GCP"
	default:
		switch getStr(dm["discoverer"]) {
		case "Amazon Web Services":
			cloud = "AWS"
		case "Microsoft Azure":
			cloud = "Azure"
		case "Google Cloud Platform":
			cloud = "GCP"
		}
	}
	var parts []string
	switch cloud {
	case "AWS":
		if z := getStr(tags["discovery_aws/availability_zone"]); z != "" {
			parts = append(parts, "Zone "+z)
		}
		if id := getStr(tags["discovery_aws/subnet_id"]); id != "" {
			parts = append(parts, id)
		}
	case "Azure":
		parts = azurePath(getStr(dm["id"]))
	case "GCP":
		if p, r := gcpLink(getStr(tags["discovery_gcp/self_link"])); p != "" {
			parts = append(parts, "Project "+p)
			if r != "" {
				parts = append(parts, "region "+r)
			}
		}
	}
	return cloud, strings.Join(parts, " · ")
}

// cloudOfZone reads an auth_zone's tags. Cloud-synced zones carry
// external_provider_<connection name>/<field> tags, and the connection name is
// whatever the admin typed ("rcuadra_aws", "Azure_AMS"), so the cloud is read
// from each connection's fields: an Azure zone_id is a /subscriptions/... path,
// a GCP zone has a project_id, an AWS zone has a caller_reference or real AWS
// name servers. The hover detail comes from that same connection only, so a
// second connection on the zone (an AD sync, say) cannot lend it its zone_id.
func cloudOfZone(tags map[string]any) (string, string) {
	conns := map[string]map[string]string{}
	var names []string
	for k, v := range tags {
		tail, ok := strings.CutPrefix(k, "external_provider_")
		conn, field, ok2 := strings.Cut(tail, "/")
		if !ok || !ok2 {
			continue
		}
		if conns[conn] == nil {
			conns[conn] = map[string]string{}
			names = append(names, conn)
		}
		conns[conn][field] = getStr(v)
	}
	sort.Strings(names)
	// A plain external_provider/<cloud> tag names the cloud but no connection;
	// the detail then comes from a connection that reads as that cloud, or
	// from the only connection there is.
	for _, c := range []string{"AWS", "Azure", "GCP"} {
		if !hasKey(tags, "external_provider/"+strings.ToLower(c)) {
			continue
		}
		for _, n := range names {
			if connCloud(conns[n]) == c {
				return c, zoneDetail(conns[n], c)
			}
		}
		if len(names) == 1 {
			return c, zoneDetail(conns[names[0]], c)
		}
		return c, ""
	}
	for _, n := range names {
		if c := connCloud(conns[n]); c != "" {
			return c, zoneDetail(conns[n], c)
		}
	}
	return "", ""
}

// connCloud reads one connection's fields as AWS, Azure, GCP or "".
func connCloud(f map[string]string) string {
	switch {
	case strings.HasPrefix(f["zone_id"], "/subscriptions/"):
		return "Azure"
	case f["project_id"] != "":
		return "GCP"
	case f["caller_reference"] != "" || awsNameServers(f["nameservers"]):
		return "AWS"
	case strings.Contains(f["nameservers"], "googledomains"):
		return "GCP"
	case strings.Contains(f["nameservers"], "azure-dns"):
		return "Azure"
	}
	return ""
}

// awsNS is a Route 53 name server: a host under awsdns-NN.com, .net, .org or
// .co.uk, such as ns-1684.awsdns-18.co.uk.
var awsNS = regexp.MustCompile(`(?i)^(?:[a-z0-9-]+\.)+awsdns-\d+\.(?:com|net|org|co\.uk)\.?$`)

// awsNameServers reads the nameservers tag (a JSON list in a string) and says
// whether any entry is a real Route 53 name server.
func awsNameServers(v string) bool {
	var hosts []string
	if json.Unmarshal([]byte(v), &hosts) != nil {
		hosts = strings.Split(v, ",")
	}
	for _, h := range hosts {
		if awsNS.MatchString(strings.TrimSpace(h)) {
			return true
		}
	}
	return false
}

// zoneDetail builds the hover line from one connection's fields.
func zoneDetail(f map[string]string, cloud string) string {
	switch cloud {
	case "AWS":
		if id := f["zone_id"]; id != "" {
			return "Hosted zone " + id
		}
	case "Azure":
		return strings.Join(azurePath(f["zone_id"]), " · ")
	case "GCP":
		if p := f["project_id"]; p != "" {
			return "Project " + p
		}
	}
	return ""
}

// azurePath reads /subscriptions/<id>/resourceGroups/<rg>/... into
// ["Subscription <id>", "resource group <rg>"].
func azurePath(p string) []string {
	seg := strings.Split(strings.Trim(p, "/"), "/")
	var out []string
	for i := 0; i+1 < len(seg); i++ {
		switch strings.ToLower(seg[i]) {
		case "subscriptions":
			out = append(out, "Subscription "+seg[i+1])
		case "resourcegroups":
			out = append(out, "resource group "+seg[i+1])
		}
	}
	return out
}

// gcpLink reads .../projects/<p>/regions/<r>/... into (p, r).
func gcpLink(link string) (project, region string) {
	seg := strings.Split(link, "/")
	for i := 0; i+1 < len(seg); i++ {
		switch seg[i] {
		case "projects":
			project = seg[i+1]
		case "regions":
			region = seg[i+1]
		}
	}
	return project, region
}

func hasKey(m map[string]any, k string) bool {
	_, ok := m[k]
	return ok
}
