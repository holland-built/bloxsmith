package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func neverAddPost(t *testing.T, d *Deps, sites ...any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"sites": sites})
	r := httptest.NewRequest("POST", "/api/lists/never-add", strings.NewReader(string(raw)))
	r.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	d.body(d.listsNeverAddSet)(rr, r)
	return rr.Code, decodeBody(t, rr)
}

func listsPlan(t *testing.T, d *Deps, dry bool, fp any, domains ...any) (int, map[string]any) {
	t.Helper()
	rr := httptest.NewRecorder()
	d.body(d.listsApply)(rr, listsRequest(map[string]any{
		"domains": domains, "list": map[string]any{"name": "top-sites"},
		"policy_id": 7, "action": "action_block_nolog", "position": 0, "dry": dry, "fingerprint": fp}))
	return rr.Code, decodeBody(t, rr)
}

// The never-add list holds on the server whatever the page sends, and a change
// to it after the preview is a different plan, so Apply refuses.
func TestListsApply_NeverAddIsLeftOutAndAChangeAfterThePreviewIsRefused(t *testing.T) {
	d, _ := newListsDeps(t, listsUpstream(200))
	d.StateDir = t.TempDir()
	if code, res := neverAddPost(t, d, "Facebook.com."); code != 200 || len(res["sites"].([]any)) != 1 || res["sites"].([]any)[0] != "facebook.com" {
		t.Fatalf("save = %d %v", code, res)
	}
	code, pre := listsPlan(t, d, true, nil, "google.com", "zoom.us", "www.facebook.com")
	if code != 200 || pre["never_add_left_out"] != float64(1) {
		t.Fatalf("preview = %d %v", code, pre)
	}
	if s := pre["sample"].([]any); len(s) != 2 || s[0] != "google.com" || s[1] != "zoom.us" {
		t.Fatalf("sample = %v, want google.com and zoom.us", s)
	}

	// google.com joins the never-add list after the preview: the sites that
	// would go in are different now, so Apply refuses and writes nothing.
	neverAddPost(t, d, "facebook.com", "google.com")
	if code, res := listsPlan(t, d, false, pre["fingerprint"], "google.com", "zoom.us", "www.facebook.com"); code != 409 {
		t.Fatalf("apply after the never-add list changed = %d %v, want 409", code, res)
	}
	if code, res := listsPlan(t, d, true, nil, "google.com"); code != 400 || !strings.Contains(anyStr(res["error"]), "never-add") {
		t.Fatalf("all on the never-add list = %d %v", code, res)
	}
}

func TestListsNeverAdd_RefusesWhatIsNotADomain(t *testing.T) {
	d, _ := newListsDeps(t, listsUpstream(200))
	d.StateDir = t.TempDir()
	if code, _ := neverAddPost(t, d, "google.com", "not a site"); code != 400 {
		t.Fatalf("code %d, want 400", code)
	}
	if never, _ := d.neverAdd(); len(never) != 0 {
		t.Fatalf("a refused save must not change the list: %v", never)
	}
}
