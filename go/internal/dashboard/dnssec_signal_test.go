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
	if sig["severity"] != "crit" {
		t.Errorf("expected crit severity when all known zones unsigned, got %v", sig["severity"])
	}
	want := "3 of 3 DNS zones unsigned (DNSSEC)"
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
	if got[0]["severity"] != "warn" {
		t.Errorf("expected warn severity for mixed fleet, got %v", got[0]["severity"])
	}
	want := "2 of 3 DNS zones unsigned (DNSSEC)"
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
	want := "1 of 1 DNS zones unsigned (DNSSEC)"
	if got[0]["message"] != want {
		t.Errorf("message = %q, want %q (unknown-status zones must be excluded)", got[0]["message"], want)
	}
	if got[0]["severity"] != "crit" {
		t.Errorf("severity = %v, want crit (the only known-status zone is unsigned)", got[0]["severity"])
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
	want := "1532 of 1533 DNS zones unsigned (DNSSEC)"
	if got[0]["message"] != want {
		t.Errorf("message = %q, want %q", got[0]["message"], want)
	}
	if got[0]["severity"] != "warn" {
		t.Errorf("severity = %v, want warn (not every known zone is unsigned)", got[0]["severity"])
	}
}
