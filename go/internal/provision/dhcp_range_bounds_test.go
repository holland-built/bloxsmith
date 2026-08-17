package provision

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// A DHCP range that does not fit its subnet is not written (#131), and neither
// is one whose start is above its end (#132).
//
// The two are separate failures and each is proved separately: #131's endpoints
// are outside the subnet, #132's are both legal addresses inside it and only
// their ORDER is wrong, so a containment check cannot catch it.

func dhcpProvisioner(t *testing.T, subnetSize int, dry bool) (*SiteProvisioner, M) {
	t.Helper()
	cfg := testSiteConfig()
	cfg.SubnetSize = subnetSize
	cfg.DryRun = dry
	return New(nil, "").NewSiteProvisioner(cfg, func(M) {}), M{}
}

func skippedRows(t *testing.T, result M) []M {
	t.Helper()
	var out []M
	for _, r := range getList(result, "dhcp_ranges_skipped") {
		out = append(out, asMap(r))
	}
	return out
}

// --- Part A: createDHCPRange refuses to write a range it cannot place --------

func TestCreateDHCPRange_SkipsWhenItCannotBePlaced(t *testing.T) {
	cases := []struct {
		name       string
		subnetSize int
		sdef       SubnetDef
		subnet     M
		wantReason string
	}{
		{
			// TemplateToSiteConfig's synthesized default plan: dhcp true, no
			// offsets, so 10 and 250 apply. Three shipped templates use /25.
			name:       "default offsets on a /25",
			subnetSize: 25,
			sdef:       SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true"},
			subnet:     M{"address": "10.20.30.0", "cidr": 25},
			wantReason: "fall outside subnet 10.20.30.0/25",
		},
		{
			// An explicit end that the old hardcoded 1-254 accepted.
			name:       "explicit dhcp_end 250 on a /26",
			subnetSize: 26,
			sdef:       SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true", DhcpStart: 5, DhcpEnd: 250},
			subnet:     M{"address": "10.20.30.64", "cidr": 26},
			wantReason: "fall outside subnet 10.20.30.64/26",
		},
		{
			// START outside, END inside, and NOT backwards (-5 < 100) so the
			// ordering guard cannot fire. This is the only case that proves the
			// start half of the containment check on its own: with a backwards
			// pair, deleting !ipInNet(startIP, n) would still be refused by the
			// ordering guard and the mutation would look survived.
			name:       "negative start offset wraps below the subnet",
			subnetSize: 25,
			sdef:       SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true", DhcpStart: -5, DhcpEnd: 100},
			subnet:     M{"address": "10.20.30.0", "cidr": 25},
			wantReason: "fall outside subnet 10.20.30.0/25",
		},
		{
			// #132: both endpoints are legal addresses inside the /24.
			name:       "backwards range, both endpoints inside the subnet",
			subnetSize: 24,
			sdef:       SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true", DhcpStart: 200, DhcpEnd: 100},
			subnet:     M{"address": "10.20.30.0", "cidr": 24},
			wantReason: "backwards range",
		},
		{
			name:       "subnet address that cannot be parsed",
			subnetSize: 24,
			sdef:       SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true"},
			subnet:     M{"address": "not-an-address", "cidr": 24},
			wantReason: "could not be parsed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, result := dhcpProvisioner(t, tc.subnetSize, true)
			if err := p.createDHCPRange(tc.subnet, tc.sdef, result); err != nil {
				t.Fatalf("createDHCPRange() error = %v, want nil — a bad range must not abort a live site", err)
			}
			if rows := getList(result, "dhcp_ranges"); len(rows) != 0 {
				t.Fatalf("dhcp_ranges = %v, want empty — the range was not created", rows)
			}
			skipped := skippedRows(t, result)
			if len(skipped) != 1 {
				t.Fatalf("dhcp_ranges_skipped = %v, want exactly one row", skipped)
			}
			reason, _ := skipped[0]["reason"].(string)
			if !strings.Contains(reason, tc.wantReason) {
				t.Fatalf("reason = %q, want it to contain %q", reason, tc.wantReason)
			}
			if name := pyStr(skipped[0]["name"]); name != "test-lan-dhcp" {
				t.Fatalf("name = %q, want test-lan-dhcp so the operator can tell which subnet", name)
			}
		})
	}
}

// An IPv6 subnet has no IPv4 address to report, and the old code turned that
// into the literal string "<nil>" in the POST body.
func TestCreateDHCPRange_IPv6SubnetRecordsNoFabricatedAddress(t *testing.T) {
	p, result := dhcpProvisioner(t, 64, true)
	sdef := SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true"}
	if err := p.createDHCPRange(M{"address": "2001:db8::", "cidr": 64}, sdef, result); err != nil {
		t.Fatalf("createDHCPRange() error = %v, want nil", err)
	}
	skipped := skippedRows(t, result)
	if len(skipped) != 1 {
		t.Fatalf("dhcp_ranges_skipped = %v, want exactly one row", skipped)
	}
	for _, k := range []string{"start", "end"} {
		if got := pyStr(skipped[0][k]); got != "" {
			t.Fatalf("%s = %q, want empty — there is no IPv4 address to report", k, got)
		}
	}
	if rendered := fmt.Sprintf("%v", result); strings.Contains(rendered, "<nil>") {
		t.Fatalf("result contains the literal \"<nil>\": %s", rendered)
	}
}

// The common path must still work — this fix must not stop DHCP ranges being
// created for the subnets that can hold them.
func TestCreateDHCPRange_PlaceableRangesAreStillCreated(t *testing.T) {
	cases := []struct {
		name               string
		subnetSize         int
		sdef               SubnetDef
		subnet             M
		wantStart, wantEnd string
	}{
		{
			// The shipped emea/amer lab values.
			name:       "explicit 20-120 inside a /25",
			subnetSize: 25,
			sdef:       SubnetDef{Name: "test-lan", Dhcp: "true", DhcpStart: 20, DhcpEnd: 120},
			subnet:     M{"address": "10.20.30.0", "cidr": 25},
			wantStart:  "10.20.30.20", wantEnd: "10.20.30.120",
		},
		{
			name:       "default offsets on a /24",
			subnetSize: 24,
			sdef:       SubnetDef{Name: "test-lan", Dhcp: "true"},
			subnet:     M{"address": "10.20.30.0", "cidr": 24},
			wantStart:  "10.20.30.10", wantEnd: "10.20.30.250",
		},
		{
			// Exactly the last usable offset of a /26 — the boundary that
			// separates 2^(32-cidr)-2 from -1.
			name:       "end offset exactly at the /26 ceiling",
			subnetSize: 26,
			sdef:       SubnetDef{Name: "test-lan", Dhcp: "true", DhcpStart: 5, DhcpEnd: 62},
			subnet:     M{"address": "10.20.30.64", "cidr": 26},
			wantStart:  "10.20.30.69", wantEnd: "10.20.30.126",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, result := dhcpProvisioner(t, tc.subnetSize, true)
			if err := p.createDHCPRange(tc.subnet, tc.sdef, result); err != nil {
				t.Fatalf("createDHCPRange() error = %v", err)
			}
			if rows := skippedRows(t, result); len(rows) != 0 {
				t.Fatalf("dhcp_ranges_skipped = %v, want empty — this range fits", rows)
			}
			rows := getList(result, "dhcp_ranges")
			if len(rows) != 1 {
				t.Fatalf("dhcp_ranges = %v, want exactly one row", rows)
			}
			row := asMap(rows[0])
			if pyStr(row["start"]) != tc.wantStart || pyStr(row["end"]) != tc.wantEnd {
				t.Fatalf("range = %s-%s, want %s-%s", row["start"], row["end"], tc.wantStart, tc.wantEnd)
			}
		})
	}
}

// The skip must happen BEFORE the POST, not be tidied up after it.
func TestCreateDHCPRange_LiveSkipIssuesNoRequest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("upstream was called (%s %s) — an unplaceable range must not be POSTed", r.Method, r.URL.Path)
		w.WriteHeader(500)
	}))
	defer srv.Close()

	cfg := testSiteConfig()
	cfg.SubnetSize = 25
	cfg.DryRun = false
	p := newTestEngine(srv).NewSiteProvisioner(cfg, func(M) {})
	result := M{}
	sdef := SubnetDef{Name: "test-lan", Purpose: "user-lan", Dhcp: "true"}

	if err := p.createDHCPRange(M{"address": "10.20.30.0", "cidr": 25}, sdef, result); err != nil {
		t.Fatalf("createDHCPRange() error = %v, want nil", err)
	}
	if rows := skippedRows(t, result); len(rows) != 1 {
		t.Fatalf("dhcp_ranges_skipped = %v, want exactly one row", rows)
	}
}

// --- Part B: validation bounds the offsets by the subnet, not by a constant --

func validate(t *testing.T, src string) M {
	t.Helper()
	var data any
	if err := yaml.Unmarshal([]byte(src), &data); err != nil {
		t.Fatalf("yaml: %v", err)
	}
	m := asMap(normalizeYAML(data))
	if m == nil {
		t.Fatalf("template did not parse as a mapping")
	}
	return ValidateTemplate(m, "test.yaml")
}

func fields(rows []M) string {
	var out []string
	for _, r := range rows {
		out = append(out, pyStr(r["field"])+": "+pyStr(r["message"]))
	}
	return strings.Join(out, " | ")
}

func errsAndWarns(t *testing.T, out M) (errs, warns []M) {
	t.Helper()
	for _, e := range out["errors"].([]M) {
		errs = append(errs, e)
	}
	for _, w := range out["warnings"].([]M) {
		warns = append(warns, w)
	}
	return errs, warns
}

const siteHead = "site:\n  name: hq\n  region: emea\n  environment: prod\ndns:\n  parent: example.com\nnetwork:\n  ip_space: default\n"

func TestValidateSite_DHCPOffsetsBoundedBySubnet(t *testing.T) {
	cases := []struct {
		name      string
		yaml      string
		wantValid bool
		wantIn    string // substring expected in the errors (or warnings if valid)
	}{
		{
			// An offset the OPERATOR wrote that cannot be honoured: error.
			name:      "explicit dhcp_end 250 on a /26 is an error",
			yaml:      siteHead + "  subnets:\n    - name: hq-lan\n      cidr: 26\n      dhcp: true\n      dhcp_start: 5\n      dhcp_end: 250\n",
			wantValid: false,
			wantIn:    "outside 1-62 for a /26 subnet",
		},
		{
			// OUR default on their subnet: warning, so the site's subnets, zone
			// and hosts are not blocked by a number we chose.
			name:      "omitted offsets on a /26 are a warning",
			yaml:      siteHead + "  subnets:\n    - name: hq-lan\n      cidr: 26\n      dhcp: true\n",
			wantValid: true,
			wantIn:    "outside 1-62 for a /26 subnet",
		},
		{
			// The synthesized default plan — no subnets key at all. This is the
			// commonest way into #131 and it used to validate spotlessly.
			name:      "no subnets key with subnet_size 25 is a warning",
			yaml:      siteHead + "  subnet_size: 25\n",
			wantValid: true,
			wantIn:    "cannot hold the default DHCP range (offsets 10-250)",
		},
		{
			name:      "backwards explicit offsets are an error",
			yaml:      siteHead + "  subnets:\n    - name: hq-lan\n      cidr: 24\n      dhcp: true\n      dhcp_start: 200\n      dhcp_end: 100\n",
			wantValid: false,
			wantIn:    "describes a backwards range",
		},
		{
			// The ceiling boundary. 62 is the last usable offset of a /26; 63 is
			// the broadcast address. This pair is what proves -2 rather than -1 —
			// the 250 cases above exceed both and cannot tell them apart.
			name:      "dhcp_end 63 on a /26 is the broadcast address",
			yaml:      siteHead + "  subnets:\n    - name: hq-lan\n      cidr: 26\n      dhcp: true\n      dhcp_start: 5\n      dhcp_end: 63\n",
			wantValid: false,
			wantIn:    "outside 1-62 for a /26 subnet",
		},
		{
			name:      "dhcp_start 0 is the network address",
			yaml:      siteHead + "  subnets:\n    - name: hq-lan\n      cidr: 24\n      dhcp: true\n      dhcp_start: 0\n      dhcp_end: 100\n",
			wantValid: false,
			wantIn:    "outside 1-254 for a /24 subnet",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := validate(t, tc.yaml)
			errs, warns := errsAndWarns(t, out)
			if out["valid"] != tc.wantValid {
				t.Fatalf("valid = %v, want %v (errors: %s) (warnings: %s)",
					out["valid"], tc.wantValid, fields(errs), fields(warns))
			}
			hay := fields(errs)
			if tc.wantValid {
				hay = fields(warns)
			}
			if !strings.Contains(hay, tc.wantIn) {
				t.Fatalf("got %q, want it to contain %q", hay, tc.wantIn)
			}
		})
	}
}

// 62 accepted / 63 rejected is the pair that pins the ceiling. Kept beside the
// rejection case above so widening the formula by one cannot pass both.
func TestValidateSite_LastUsableOffsetIsAccepted(t *testing.T) {
	for _, tc := range []struct{ cidr, offset int }{{26, 62}, {24, 254}, {25, 126}} {
		out := validate(t, siteHead+
			"  subnets:\n    - name: hq-lan\n      cidr: "+itoa(tc.cidr)+
			"\n      dhcp: true\n      dhcp_start: 1\n      dhcp_end: "+itoa(tc.offset)+"\n")
		errs, _ := errsAndWarns(t, out)
		if out["valid"] != true {
			t.Fatalf("/%d offset %d: valid = false, want true — that is the last usable host (errors: %s)",
				tc.cidr, tc.offset, fields(errs))
		}
	}
}

// A cidr that is already wrong must produce ONE error about the cidr, not that
// plus a derived offset error computed from a number nobody can read. This file
// has the same mutually-exclusive convention in listOrErr.
func TestValidateSite_BadCidrDoesNotStackADerivedOffsetError(t *testing.T) {
	out := validate(t, siteHead+
		"  subnets:\n    - name: hq-lan\n      cidr: abc\n      dhcp: true\n      dhcp_end: 250\n")
	errs, _ := errsAndWarns(t, out)
	for _, e := range errs {
		if strings.Contains(pyStr(e["field"]), "dhcp_") {
			t.Fatalf("got a derived offset error alongside the cidr error: %s", fields(errs))
		}
	}
}

// The new rule must not reject — or nag about — the templates that ship.
func TestValidateSite_ShippedTemplatesStayCleanAndWarningFree(t *testing.T) {
	root := filepath.Join("..", "..", "templates")
	var checked int
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(p, ".yaml") {
			return err
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		var data any
		if err := yaml.Unmarshal(raw, &data); err != nil {
			return nil // not this test's subject
		}
		m := asMap(normalizeYAML(data))
		if m == nil || TemplateType(m) != "site" {
			return nil
		}
		checked++
		out := ValidateTemplate(m, p)
		errs, warns := errsAndWarns(t, out)
		for _, row := range append(append([]M{}, errs...), warns...) {
			if strings.Contains(pyStr(row["field"]), "dhcp_") ||
				strings.Contains(pyStr(row["message"]), "default DHCP range") {
				t.Errorf("%s: shipped template now reports a DHCP offset problem: %s: %s",
					p, row["field"], row["message"])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	// A walk that silently found nothing would pass this test while proving
	// nothing at all.
	if checked == 0 {
		t.Fatalf("no site templates found under %s — the walk proved nothing", root)
	}
}
