package dashboard

import "testing"

// zoneRow builds a minimal normZones-shaped row carrying only what
// BuildSignals' DNSSEC posture check reads.
func zoneRow(id, dnssecStatus string) map[string]any {
	return map[string]any{
		"id":            id,
		"fqdn":          id + ".example.com",
		"dnssec_status": dnssecStatus,
	}
}

func dnssecSignalsOf(t *testing.T, signals []map[string]any) []map[string]any {
	t.Helper()
	out := []map[string]any{}
	for _, s := range signals {
		if getStr(s["category"]) == "dnssec-unsigned" {
			out = append(out, s)
		}
	}
	return out
}

// TestBuildSignals_DNSSEC_AllUnsigned covers the measured production shape
// (131 of 131 auth zones UNSIGNED): expect exactly one crit signal naming
// both counts, never one signal per zone (that would blow SignalsCap).
func TestBuildSignals_DNSSEC_AllUnsigned(t *testing.T) {
	zones := []any{}
	for i := 0; i < 3; i++ {
		zones = append(zones, zoneRow("z"+string(rune('a'+i)), "UNSIGNED"))
	}
	data := map[string]any{"zones": zones}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 dnssec signal, got %d", len(got))
	}
	sig := got[0]
	// info: unsigned zones are a minor gap (owner, 2026-11-09). As crit, and
	// later as warn, it outranked real problems at the top of Overview.
	if sig["severity"] != "info" {
		t.Errorf("expected info severity when all known zones unsigned, got %v", sig["severity"])
	}
	want := "3 of 3 DNS zones with public names unsigned (DNSSEC)"
	if sig["message"] != want {
		t.Errorf("message = %q, want %q", sig["message"], want)
	}
	if sig["entity_id"] != "dnssec-posture" {
		t.Errorf("entity_id = %v, want stable constant \"dnssec-posture\"", sig["entity_id"])
	}
	if sig["category"] != "dnssec-unsigned" || sig["source"] != "dns" || sig["entity_type"] != "posture" {
		t.Errorf("unexpected signal shape: %+v", sig)
	}
}

// TestBuildSignals_DNSSEC_Mixed covers a mixed fleet: severity should be warn
// (not crit) since some zones are signed, and the message should reflect the
// unsigned count over the known-status count only.
func TestBuildSignals_DNSSEC_Mixed(t *testing.T) {
	data := map[string]any{"zones": []any{
		zoneRow("a", "UNSIGNED"),
		zoneRow("b", "UNSIGNED"),
		zoneRow("c", "SIGNED"),
	}}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 dnssec signal, got %d", len(got))
	}
	if got[0]["severity"] != "info" {
		t.Errorf("expected info severity for mixed fleet, got %v", got[0]["severity"])
	}
	want := "2 of 3 DNS zones with public names unsigned (DNSSEC)"
	if got[0]["message"] != want {
		t.Errorf("message = %q, want %q", got[0]["message"], want)
	}
}

// TestBuildSignals_DNSSEC_AllSigned covers the all-signed case: zero signals,
// since there is nothing to say.
func TestBuildSignals_DNSSEC_AllSigned(t *testing.T) {
	data := map[string]any{"zones": []any{
		zoneRow("a", "SIGNED"),
		zoneRow("b", "SIGNED"),
	}}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 0 {
		t.Fatalf("expected 0 dnssec signals when all zones signed, got %d: %+v", len(got), got)
	}
}

// TestBuildSignals_DNSSEC_UnknownStatusExcluded covers zones with an
// empty/missing dnssec_status: they must be excluded from both the numerator
// and denominator, not counted as unsigned.
func TestBuildSignals_DNSSEC_UnknownStatusExcluded(t *testing.T) {
	data := map[string]any{"zones": []any{
		zoneRow("a", "UNSIGNED"),
		zoneRow("b", ""), // unknown/missing status
		zoneRow("c", ""),
	}}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 dnssec signal, got %d", len(got))
	}
	want := "1 of 1 DNS zones with public names unsigned (DNSSEC)"
	if got[0]["message"] != want {
		t.Errorf("message = %q, want %q (unknown-status zones must be excluded)", got[0]["message"], want)
	}
	if got[0]["severity"] != "info" {
		t.Errorf("severity = %v, want info (an unsigned zone is a minor gap)", got[0]["severity"])
	}
}

// TestBuildSignals_DNSSEC_UnknownOnly covers the case where no zone carries a
// known status at all: emit nothing, since there is no ratio to report.
func TestBuildSignals_DNSSEC_UnknownOnly(t *testing.T) {
	data := map[string]any{"zones": []any{
		zoneRow("a", ""),
		zoneRow("b", ""),
	}}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 0 {
		t.Fatalf("expected 0 dnssec signals when no zone has a known status, got %d: %+v", len(got), got)
	}
}

// TestBuildSignals_DNSSEC_CapRegression guards the exact bug this signal
// must not reintroduce: a 1,533-zone estate (the measured dev-tenant size,
// with 1,532 unsigned) must still yield exactly ONE dnssec signal, not one
// per zone, so SignalsCap (2000) headroom for other categories is preserved.
func TestBuildSignals_DNSSEC_CapRegression(t *testing.T) {
	const total = 1533
	const unsigned = 1532
	zones := make([]any, 0, total)
	for i := 0; i < unsigned; i++ {
		zones = append(zones, zoneRow("u", "UNSIGNED"))
	}
	for i := unsigned; i < total; i++ {
		zones = append(zones, zoneRow("s", "SIGNED"))
	}
	data := map[string]any{"zones": zones}
	got := dnssecSignalsOf(t, BuildSignals(data))
	if len(got) != 1 {
		t.Fatalf("expected exactly 1 dnssec signal for %d zones, got %d", total, len(got))
	}
	want := "1532 of 1533 DNS zones with public names unsigned (DNSSEC)"
	if got[0]["message"] != want {
		t.Errorf("message = %q, want %q", got[0]["message"], want)
	}
	if got[0]["severity"] != "info" {
		t.Errorf("severity = %v, want info", got[0]["severity"])
	}
}

// TestBuildSignals_DNSSEC_InternalZonesNotCounted: only zones with public
// names need signing (owner, 2026-11-09). Reverse zones and private names
// must not appear in either count, and an estate of only internal zones,
// all unsigned, says nothing at all.
func TestBuildSignals_DNSSEC_InternalZonesNotCounted(t *testing.T) {
	zone := func(fqdn, status string) map[string]any {
		return map[string]any{"id": fqdn, "fqdn": fqdn, "dnssec_status": status}
	}
	internal := []any{
		zone("10.in-addr.arpa.", "UNSIGNED"),
		zone("corp.local.", "UNSIGNED"),
		zone("lab.internal.", "UNSIGNED"),
		zone("site.private.", "UNSIGNED"),
	}
	if got := dnssecSignalsOf(t, BuildSignals(map[string]any{"zones": internal})); len(got) != 0 {
		t.Fatalf("internal-only estate: want no dnssec signal, got %+v", got)
	}
	mixed := append(internal, zone("example.com.", "UNSIGNED"), zone("shop.example.co.uk.", "SIGNED"))
	got := dnssecSignalsOf(t, BuildSignals(map[string]any{"zones": mixed}))
	if len(got) != 1 {
		t.Fatalf("want 1 dnssec signal, got %d", len(got))
	}
	if want := "1 of 2 DNS zones with public names unsigned (DNSSEC)"; got[0]["message"] != want {
		t.Errorf("message = %q, want %q", got[0]["message"], want)
	}
}

func TestPublicName(t *testing.T) {
	for fqdn, want := range map[string]bool{
		"example.com.": true, "shop.example.co.uk": true, "Example.NET.": true,
		"corp.local.": false, "lab.internal.": false, "x.test.": false, "home.lab.": false,
		"10.in-addr.arpa.": false, "8.b.d.0.1.0.0.2.ip6.arpa.": false,
		"foo.github.io.": true, "com.": false, "": false,
	} {
		if got := publicName(fqdn); got != want {
			t.Errorf("publicName(%q) = %v, want %v", fqdn, got, want)
		}
	}
}
