package runs

import "testing"

func TestFindMatchesDDIByIDAndListsByTenantToo(t *testing.T) {
	l := Open(t.TempDir())
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// An older Automate run: no tenant recorded.
	must(l.Add(Run{ID: "r-1", Created: "2026-11-01T00:00:00Z", Objects: []Object{{ID: "dns/record/u1", Kind: "dns_record", State: Created}}}))
	must(l.Add(Run{ID: "r-2", Created: "2026-11-02T00:00:00Z", Source: "lists", Tenant: "t-a/-",
		Objects: []Object{{ID: "42", Kind: "custom_list", State: Created}}}))
	must(l.Add(Run{ID: "r-3", Created: "2026-11-03T00:00:00Z", Source: "delete", Tenant: "t-a/-",
		Objects: []Object{{ID: "dns/record/u9", Kind: "dns_record", State: Deleted}}}))

	if _, _, ok := l.Find("dns_record", "dns/record/u1", "t-b/-"); !ok {
		t.Error("a DDI id from an older run with no tenant should still match")
	}
	if _, _, ok := l.Find("custom_list", "42", "t-a/-"); !ok {
		t.Error("list 42 was made on t-a")
	}
	if _, _, ok := l.Find("custom_list", "42", "t-b/-"); ok {
		t.Error("list 42 on another tenant is a different list and must not match")
	}
	if _, _, ok := l.Find("dns_record", "dns/record/u9", "t-a/-"); ok {
		t.Error("a recorded delete is not proof Bloxsmith made the object")
	}

	must(l.MarkObject("r-2", "custom_list", "42", Deleted))
	if _, o, _ := l.Find("custom_list", "42", "t-a/-"); o.State != Deleted {
		t.Errorf("state after MarkObject = %q", o.State)
	}
}
