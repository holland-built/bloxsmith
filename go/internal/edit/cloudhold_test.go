package edit

import (
	"net/netip"
	"strings"
	"testing"
)

// Each cloud keeps a few addresses of every network for itself, counted from
// the network's own first address, never a literal .1.
func TestCloudHeld_OffsetsPerCloud(t *testing.T) {
	cases := []struct {
		cloud, prefix string
		want          string
	}{
		{"aws", "10.0.0.32/28", "10.0.0.33=Kept by AWS: router 10.0.0.34=Kept by AWS: DNS 10.0.0.35=Kept by AWS: future use"},
		{"aws", "10.1.2.0/24", "10.1.2.1=Kept by AWS: router 10.1.2.2=Kept by AWS: DNS 10.1.2.3=Kept by AWS: future use"},
		{"azure", "10.0.0.32/28", "10.0.0.33=Kept by Azure: gateway 10.0.0.34=Kept by Azure: DNS 10.0.0.35=Kept by Azure: DNS"},
		{"azure", "10.1.2.0/24", "10.1.2.1=Kept by Azure: gateway 10.1.2.2=Kept by Azure: DNS 10.1.2.3=Kept by Azure: DNS"},
		{"gcp", "10.0.0.32/28", "10.0.0.33=Kept by Google Cloud: gateway 10.0.0.46=Kept by Google Cloud: reserved by Google"},
		{"gcp", "10.1.2.0/24", "10.1.2.1=Kept by Google Cloud: gateway 10.1.2.254=Kept by Google Cloud: reserved by Google"},
		{"", "10.1.2.0/24", ""},
		{"none", "10.1.2.0/24", ""},
	}
	for _, c := range cases {
		var got []string
		for _, h := range CloudHeld(c.cloud, netip.MustParsePrefix(c.prefix)) {
			got = append(got, h.Address+"="+h.Label)
		}
		if g := strings.Join(got, " "); g != c.want {
			t.Errorf("%s %s = %q, want %q", c.cloud, c.prefix, g, c.want)
		}
	}
}

func TestCloudSizeCheck_AWSRefusesSmallerThan28(t *testing.T) {
	if msg := CloudSizeCheck("aws", 29); !strings.Contains(msg, "AWS") {
		t.Fatalf("aws /29 = %q, want a plain refusal", msg)
	}
	for _, ok := range []struct {
		cloud string
		cidr  int
	}{{"aws", 28}, {"aws", 24}, {"", 29}, {"azure", 29}, {"gcp", 29}} {
		if msg := CloudSizeCheck(ok.cloud, ok.cidr); msg != "" {
			t.Errorf("%s /%d refused: %q", ok.cloud, ok.cidr, msg)
		}
	}
	if msg := CloudSizeCheck("oracle", 24); msg == "" {
		t.Fatal("an unknown cloud was accepted")
	}
}
