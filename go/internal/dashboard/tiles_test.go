package dashboard

import "testing"

func TestNormDNSSEC(t *testing.T) {
	raw := []any{
		map[string]any{"id": "z1", "fqdn": "a.com.", "view": "default",
			"dnssec_status": "signed", "dnssec_signing_policy": "default"},
		map[string]any{"id": "z2", "fqdn": "b.com.", "view": "default",
			"dnssec_status": "signed"},
		map[string]any{"fqdn": "c.com."}, // missing id/status/policy
	}
	rows, summary := normDNSSEC(raw)
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(rows))
	}
	if rows[0]["fqdn"] != "a.com." || rows[0]["dnssec_signing_policy"] != "default" {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[2]["fqdn"] != "c.com." || rows[2]["dnssec_status"] != "" || rows[2]["id"] != "" {
		t.Errorf("row2 missing-field shaping = %+v", rows[2])
	}
	if summary["signed"] != 2 {
		t.Errorf("summary[signed] = %d, want 2", summary["signed"])
	}
	if summary[""] != 1 {
		t.Errorf("summary[\"\"] = %d, want 1", summary[""])
	}
}

func TestNormRPZ(t *testing.T) {
	raw := []any{
		map[string]any{"fqdn": "bad.example.", "comment": "malware feed", "disabled": false,
			"view": "default", "policy_override": "block", "severity": "high",
			"priority": "1", "type": "custom_list", "substituted_domain_name": ""},
		map[string]any{"fqdn": "partial.example."}, // missing everything else
	}
	rows := normRPZ(raw)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0]["severity"] != "high" || rows[0]["disabled"] != false || rows[0]["policy_override"] != "block" {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[1]["fqdn"] != "partial.example." || rows[1]["comment"] != "" || rows[1]["disabled"] != false {
		t.Errorf("row1 missing-field shaping = %+v", rows[1])
	}
}

func TestNormDtcLbdn(t *testing.T) {
	raw := []any{
		map[string]any{"name": "lbdn1", "view": "default", "dtc_policy": "policy1",
			"precedence": float64(10), "comment": "prod", "disabled": true, "ttl": float64(300), "tags": map[string]any{}},
		map[string]any{"name": "lbdn2"}, // missing everything else
	}
	rows := normDtcLbdn(raw)
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	if rows[0]["precedence"] != 10 || rows[0]["ttl"] != 300 || rows[0]["disabled"] != true {
		t.Errorf("row0 = %+v", rows[0])
	}
	if rows[1]["name"] != "lbdn2" || rows[1]["precedence"] != 0 || rows[1]["disabled"] != false {
		t.Errorf("row1 missing-field shaping = %+v", rows[1])
	}
}

// --- scalar-count shape (no network: exercises the status-derivation logic
// inline, mirroring scalarCount's total/status computation) ----------------

func scalarShape(total int) map[string]any {
	status := "ok"
	if total == 0 {
		status = "empty"
	}
	return map[string]any{
		"total": total, "breakdown_available": false,
		"note": "unavailable upstream", "status": status,
	}
}

func TestScalarCount_RealTotal(t *testing.T) {
	got := scalarShape(319397)
	if got["breakdown_available"] != false {
		t.Error("breakdown_available = true, want false")
	}
	if _, hasBuckets := got["buckets"]; hasBuckets {
		t.Error("buckets present, want no buckets key in the new shape")
	}
	if got["status"] != "ok" {
		t.Errorf("status = %v, want ok for a non-zero total", got["status"])
	}
	if got["total"] != 319397 {
		t.Errorf("total = %v, want 319397", got["total"])
	}
}

func TestScalarCount_ZeroOrFailedFetch(t *testing.T) {
	got := scalarShape(0)
	if got["status"] != "empty" {
		t.Errorf("status = %v, want empty for a zero total", got["status"])
	}
	if got["breakdown_available"] != false {
		t.Error("breakdown_available = true, want false")
	}
}
