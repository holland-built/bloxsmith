package dashboard

import (
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
// from the fields: an Azure zone_id is a /subscriptions/... path, a GCP zone
// has a project_id, an AWS zone has a caller_reference or awsdns name servers.
func cloudOfZone(tags map[string]any) (string, string) {
	for _, c := range []string{"aws", "azure", "gcp"} {
		if hasKey(tags, "external_provider/"+c) {
			return map[string]string{"aws": "AWS", "azure": "Azure", "gcp": "GCP"}[c], zoneDetail(tags, c)
		}
	}
	keys := make([]string, 0, len(tags))
	for k := range tags {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !strings.HasPrefix(k, "external_provider_") {
			continue
		}
		v := getStr(tags[k])
		switch {
		case strings.HasSuffix(k, "/zone_id") && strings.HasPrefix(v, "/subscriptions/"):
			return "Azure", zoneDetail(tags, "azure")
		case strings.HasSuffix(k, "/project_id"):
			return "GCP", zoneDetail(tags, "gcp")
		case strings.HasSuffix(k, "/caller_reference"):
			return "AWS", zoneDetail(tags, "aws")
		case strings.HasSuffix(k, "/nameservers"):
			switch {
			case strings.Contains(v, "awsdns"):
				return "AWS", zoneDetail(tags, "aws")
			case strings.Contains(v, "googledomains"):
				return "GCP", zoneDetail(tags, "gcp")
			case strings.Contains(v, "azure-dns"):
				return "Azure", zoneDetail(tags, "azure")
			}
		}
	}
	return "", ""
}

// zoneDetail builds the hover line from the first external_provider_* tag of
// the field it needs. cloud is lower case: aws, azure or gcp.
func zoneDetail(tags map[string]any, cloud string) string {
	field := func(suffix string) string {
		keys := make([]string, 0, len(tags))
		for k := range tags {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if strings.HasPrefix(k, "external_provider_") && strings.HasSuffix(k, "/"+suffix) {
				if v := getStr(tags[k]); v != "" {
					return v
				}
			}
		}
		return ""
	}
	switch cloud {
	case "aws":
		if id := field("zone_id"); id != "" {
			return "Hosted zone " + id
		}
	case "azure":
		return strings.Join(azurePath(field("zone_id")), " · ")
	case "gcp":
		if p := field("project_id"); p != "" {
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
