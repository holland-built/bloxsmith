package dashboard

import "testing"

// Tag shapes copied from the live tenant on 2026-11-17 (subnets carry
// external_provider/<cloud>: "true" plus discovery_<cloud>/* tags; zones carry
// external_provider_<connection name>/* tags, where the connection name is
// whatever the admin typed, so the cloud is read from the tag's shape).

func TestCloudOfSubnet(t *testing.T) {
	cases := []struct {
		name, cloud, detail string
		row                 map[string]any
	}{
		{"aws", "AWS", "Zone us-east-1a · subnet-0b9b8e950df11095c", map[string]any{
			"tags": map[string]any{"external_provider/aws": "true", "discovery_aws/availability_zone": "us-east-1a",
				"discovery_aws/subnet_id": "subnet-0b9b8e950df11095c", "discovery_aws/provider_id": "kokf26uhkpmk3fvl5oneq3xicwmnazbk"},
			"discovery_metadata": map[string]any{"discoverer": "Amazon Web Services"}}},
		{"azure", "Azure", "Subscription e4c1fa5d-21a9-498b-b32c-921112f89dd9 · resource group tbrown1-rg", map[string]any{
			"tags": map[string]any{"external_provider/azure": "true", "discovery_azure/location": ""},
			"discovery_metadata": map[string]any{"discoverer": "Microsoft Azure",
				"id": "/subscriptions/e4c1fa5d-21a9-498b-b32c-921112f89dd9/resourceGroups/tbrown1-rg/providers/Microsoft.Network/virtualNetworks/vnet-eastus-5/subnets/snet-eastus-1"}}},
		{"gcp", "GCP", "Project gcp-sa-coreddi · region us-west1", map[string]any{
			"tags": map[string]any{"external_provider/gcp": "true",
				"discovery_gcp/self_link": "https://www.googleapis.com/compute/v1/projects/gcp-sa-coreddi/regions/us-west1/subnetworks/pnguyen1-subnet1",
				"discovery_gcp/region":    "https://www.googleapis.com/compute/v1/projects/gcp-sa-coreddi/regions/us-west1"}}},
		{"discoverer only", "Azure", "", map[string]any{"discovery_metadata": map[string]any{"discoverer": "Microsoft Azure"}}},
		{"nios import", "", "", map[string]any{"tags": map[string]any{"nios/grid_name": "Infoblox-69b3", "nios_ea/Site": "FAY"},
			"discovery_metadata": map[string]any{"discoverer": "Network Insight"}}},
		{"no tags", "", "", map[string]any{}},
	}
	for _, c := range cases {
		cloud, detail := cloudOfSubnet(c.row)
		if cloud != c.cloud || detail != c.detail {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, cloud, detail, c.cloud, c.detail)
		}
	}
}

func TestCloudOfZone(t *testing.T) {
	cases := []struct {
		name, cloud, detail string
		tags                map[string]any
	}{
		{"aws, own connection name", "AWS", "Hosted zone Z0374616L3S29TWJPZR1", map[string]any{
			"external_provider_rcuadra_aws/caller_reference": "8424ab76-31b7-437b-bd16-0053330705eb",
			"external_provider_rcuadra_aws/nameservers":      `["ns-1684.awsdns-18.co.uk","ns-1337.awsdns-39.org"]`,
			"external_provider_rcuadra_aws/zone_id":          "Z0374616L3S29TWJPZR1"}},
		{"aws, name servers only", "AWS", "Hosted zone Z0199693V92DXB1B2V87", map[string]any{
			"external_provider_x/nameservers": `["ns-392.awsdns-49.com"]`,
			"external_provider_x/zone_id":     "Z0199693V92DXB1B2V87"}},
		{"azure private zone", "Azure", "Subscription e4c1fa5d-21a9-498b-b32c-921112f89dd9 · resource group ctetrick-rg", map[string]any{
			"external_provider_Azure_AMS/resource_record_set_count": "2",
			"external_provider_Azure_AMS/zone_id":                   "/subscriptions/e4c1fa5d-21a9-498b-b32c-921112f89dd9/resourceGroups/ctetrick-rg/providers/Microsoft.Network/privateDnsZones/azr.ctetrick.private"}},
		{"gcp", "GCP", "Project gcp-sa-coreddi", map[string]any{
			"external_provider_GCP_AMS/nameservers": `["ns-gcp-private.googledomains.com."]`,
			"external_provider_GCP_AMS/project_id":  "gcp-sa-coreddi",
			"external_provider_GCP_AMS/zone_id":     "2775401451156925539"}},
		{"microsoft AD is not a cloud", "", "", map[string]any{
			"external_provider/msad":           "true",
			"external_provider_ked23k/zone_id": "ked23k_peterp.local"}},
		{"cloudflare is not one of the three", "", "", map[string]any{
			"external_provider_LAYER8cf/nameservers": `["amber.ns.cloudflare.com"]`,
			"external_provider_LAYER8cf/zone_id":     "c42d68243890cdac3ec61ae8984d901e"}},
		{"plain zone", "", "", map[string]any{"Owner": "jbrockway", "nios/grid_name": "x"}},
	}
	for _, c := range cases {
		cloud, detail := cloudOfZone(c.tags)
		if cloud != c.cloud || detail != c.detail {
			t.Errorf("%s: got (%q, %q), want (%q, %q)", c.name, cloud, detail, c.cloud, c.detail)
		}
	}
}

// The normalisers carry the two new fields to the UI.
func TestNormCarriesCloud(t *testing.T) {
	s := normSubnets([]any{map[string]any{"id": "a", "address": "10.0.0.0", "cidr": 24,
		"tags": map[string]any{"external_provider/aws": "true", "discovery_aws/availability_zone": "us-east-1a"}}})
	if s[0]["cloud"] != "AWS" || s[0]["cloud_detail"] != "Zone us-east-1a" {
		t.Fatalf("subnet cloud = %v / %v", s[0]["cloud"], s[0]["cloud_detail"])
	}
	z := normZones([]any{map[string]any{"id": "z", "fqdn": "a.", "tags": map[string]any{
		"external_provider_GCP_AMS/project_id": "p1"}}}, nil)
	if z[0]["cloud"] != "GCP" || z[0]["cloud_detail"] != "Project p1" {
		t.Fatalf("zone cloud = %v / %v", z[0]["cloud"], z[0]["cloud_detail"])
	}
}

// Only real AWS name servers (…awsdns-NN.com/.net/.org/.co.uk) mean AWS; a
// name that merely contains "awsdns" does not.
func TestCloudOfZone_AWSNameServersMustBeReal(t *testing.T) {
	for _, ns := range []string{`["ns1.myawsdns.example.com"]`, `["ns-1.awsdns-12.com.evil.net"]`, `["awsdns-12.example.org"]`} {
		if cloud, _ := cloudOfZone(map[string]any{"external_provider_x/nameservers": ns}); cloud != "" {
			t.Errorf("%s: got %q, want blank", ns, cloud)
		}
	}
	for _, ns := range []string{`["ns-1684.awsdns-18.co.uk","ns-1337.awsdns-39.org"]`, `["ns-956.awsdns-55.net."]`} {
		if cloud, _ := cloudOfZone(map[string]any{"external_provider_x/nameservers": ns}); cloud != "AWS" {
			t.Errorf("%s: got %q, want AWS", ns, cloud)
		}
	}
}

// The hover comes from the same connection that decided the cloud, not from
// whichever connection's tag sorts first.
func TestCloudOfZone_DetailFromTheDecidingConnection(t *testing.T) {
	cloud, detail := cloudOfZone(map[string]any{
		"external_provider/msad":                      "true",
		"external_provider_0ad/zone_id":               "0ad_lab.example",
		"external_provider_team_aws/caller_reference": "ref-1",
		"external_provider_team_aws/zone_id":          "Z111",
	})
	if cloud != "AWS" || detail != "Hosted zone Z111" {
		t.Fatalf("got (%q, %q), want (AWS, Hosted zone Z111)", cloud, detail)
	}
}
