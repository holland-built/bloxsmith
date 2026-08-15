package edit

// Tests for the third UPDATE outcome (issue #76): upstream ACCEPTED the PATCH,
// the customer's object carries the new values, and the response cannot be read
// back as that object.
//
// Why this file exists. All five update builders used to end with
// `(status != 200 && status != 201) || resp == nil` — so a 204 No Content, an
// empty 200 and a non-JSON 200 all landed in the failure arm. rest.Client.Write
// nils the body for every one of them (and for a truncated read, since it
// discards both the io.ReadAll error and the decode error), so the operator was
// told "update failed (status 200)" — a sentence that refutes itself — while the
// change was live on the tenant, and the route layer's ok-gated audit row wrote
// nothing at all. The create side already had this outcome; the update side did
// not.
//
// What is asserted, and why each part is needed:
//
//   - the outcome is NEITHER ok:true nor ok:false. Both were tried by the code
//     this replaces and both lie in a different direction, so the absence of the
//     key is itself the assertion;
//   - the message is present. Both UI tabs branch on `j.error`
//     (ui/src/tabs/Editor.jsx:171/213, SelfService.jsx), so that key is what
//     stops an unconfirmed change from painting the screen green. A result
//     without it would be a silent success;
//   - no reply carrying a body is HTTP 204. 204 means no content, and the route
//     handlers pass a builder's status straight to d.json;
//   - a genuine 4xx/5xx is untouched, which is what keeps this from degenerating
//     into "call every failure a maybe".
//
// All upstream traffic is an httptest fake.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// updateCase is one builder, driven through its update path.
type updateCase struct {
	name     string
	id       string
	resource string
	call     func(*Client) (M, int)
	okKey    string // the key the CLEAN result puts the object under
}

func updateCases() []updateCase {
	return []updateCase{
		{"DNSRecordUpdate", "dns/record/r-1", "DNS record", func(c *Client) (M, int) {
			return c.DNSRecordUpdate(M{"id": "dns/record/r-1", "ttl": float64(60), "dry": false})
		}, "record"},
		{"ZoneUpdate", "dns/auth_zone/z-1", "DNS zone", func(c *Client) (M, int) {
			return c.ZoneUpdate(M{"id": "dns/auth_zone/z-1", "comment": "c", "dry": false})
		}, "zone"},
		{"SubnetUpdate", "ipam/subnet/s-1", "subnet", func(c *Client) (M, int) {
			return c.SubnetUpdate(M{"id": "ipam/subnet/s-1", "name": "n", "dry": false})
		}, "subnet"},
		{"RangeUpdate", "ipam/range/g-1", "DHCP range", func(c *Client) (M, int) {
			return c.RangeUpdate(M{"id": "ipam/range/g-1", "comment": "c", "dry": false})
		}, "range"},
		{"HostUpdate", "ipam/host/h-1", "host", func(c *Client) (M, int) {
			return c.HostUpdate(M{"id": "ipam/host/h-1", "name": "n", "dry": false})
		}, "host"},
	}
}

// unreadableUpdateFake answers the pre-update GET (DNSRecordUpdate makes one) with a real
// record, and every write with the case's status and body. patchStatus 405 on
// the first call exercises the PATCH->PUT fallback.
func unreadableUpdateFake(t *testing.T, status int, body string, first405 bool) (*Client, *int) {
	t.Helper()
	writes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(200)
			_, _ = io.WriteString(w,
				`{"result":{"id":"dns/record/r-1","type":"A","dns_rdata":"10.0.0.1","ttl":300}}`)
			return
		}
		writes++
		if first405 && writes == 1 {
			w.WriteHeader(405)
			return
		}
		if body != "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		if body != "" {
			_, _ = io.WriteString(w, body)
		}
	}))
	t.Cleanup(srv.Close)
	return newTestClient(srv), &writes
}

// The six upstream answers that all mean "accepted, and not readable back".
var unreadableAnswers = []struct {
	name   string
	status int
	body   string
}{
	{"empty 200", 200, ""},
	{"204 no content", 204, ""},
	{"202 accepted", 202, ""},
	{"non-JSON 200", 200, "OK"},
	{"JSON array 200", 200, `[{"id":"x"}]`},
	{"JSON scalar 200", 200, `"done"`},
}

// TestUpdateAcceptedButUnreadableIsNotAFailure is the headline. The JSON-array
// and JSON-scalar rows are a DELIBERATE behaviour change in the other direction:
// they used to pass as ok:true, putting an array where the updated object should
// be, because the old check was `resp == nil` while the create side's has always
// been `asMap(resp) == nil`.
func TestUpdateAcceptedButUnreadableIsNotAFailure(t *testing.T) {
	for _, uc := range updateCases() {
		for _, ans := range unreadableAnswers {
			t.Run(uc.name+"/"+ans.name, func(t *testing.T) {
				c, _ := unreadableUpdateFake(t, ans.status, ans.body, false)
				res, status := uc.call(c)

				if _, present := res["ok"]; present {
					t.Fatalf("result carries an \"ok\" key (%v) — this outcome is neither a "+
						"success nor a failure and must claim neither: %v", res["ok"], res)
				}
				if res[UpdatedUnreadableKey] != true {
					t.Fatalf("%s not set: %v", UpdatedUnreadableKey, res)
				}
				if res["id"] != uc.id {
					t.Fatalf("id = %v, want %q — without it the operator cannot re-read the object",
						res["id"], uc.id)
				}
				if res["resource"] != uc.resource {
					t.Fatalf("resource = %v, want %q", res["resource"], uc.resource)
				}
				if res["status"] != ans.status {
					t.Fatalf("status field = %v, want the real upstream %d", res["status"], ans.status)
				}
				msg := pyStr(res["error"])
				if msg == "" {
					t.Fatalf("no message — both UI tabs branch on j.error, so without it the " +
						"screen reports an unconfirmed change as a clean success")
				}
				if strings.Contains(msg, "update failed") {
					t.Fatalf("message still says the update failed: %q", msg)
				}
				if _, present := res[uc.okKey]; present {
					t.Fatalf("result carries a %q object it cannot have read: %v", uc.okKey, res)
				}
				if status == 204 {
					t.Fatalf("HTTP 204 with a body — 204 means no content, and the route layer "+
						"passes this status straight to d.json; want 200 (result: %v)", res)
				}
				// 202 Accepted may legally carry a body, so it passes straight
				// through; only 204 is rewritten. What matters is that this arm
				// never answers with a failure code — the change did land.
				if status < 200 || status > 299 {
					t.Fatalf("status = %d, want a 2xx: upstream accepted the change", status)
				}
				if ans.status == 204 && status != 200 {
					t.Fatalf("status = %d, want 200 in place of upstream's 204", status)
				}
			})
		}
	}
}

// TestUpdateFailureArmIsUnchanged is the other half: this must not turn genuine
// refusals into maybes. A 4xx/5xx is upstream having answered and said no.
func TestUpdateFailureArmIsUnchanged(t *testing.T) {
	for _, uc := range updateCases() {
		for _, code := range []int{400, 403, 404, 409, 500, 502} {
			t.Run(uc.name+"/"+http.StatusText(code), func(t *testing.T) {
				c, _ := unreadableUpdateFake(t, code, `{"error":"refused"}`, false)
				res, status := uc.call(c)
				if res["ok"] != false {
					t.Fatalf("ok = %v, want false for an upstream %d", res["ok"], code)
				}
				if res[UpdatedUnreadableKey] != nil {
					t.Fatalf("a refused update was marked unconfirmed: %v", res)
				}
				if status != code {
					t.Fatalf("status = %d, want the real upstream %d", status, code)
				}
			})
		}
	}
}

// TestUpdateCleanPathIsUnchanged pins the ordinary case: a readable object still
// comes back ok:true under its own key.
func TestUpdateCleanPathIsUnchanged(t *testing.T) {
	for _, uc := range updateCases() {
		t.Run(uc.name, func(t *testing.T) {
			c, _ := unreadableUpdateFake(t, 200, `{"result":{"id":"obj-1","name":"after"}}`, false)
			res, status := uc.call(c)
			if res["ok"] != true || status != 200 {
				t.Fatalf("= (%v, %d), want ok:true 200", res, status)
			}
			obj := asMap(res[uc.okKey])
			if obj == nil || obj["name"] != "after" {
				t.Fatalf("%s = %v, want the updated object", uc.okKey, res[uc.okKey])
			}
		})
	}
}

// TestUpdateNeverSaysFailedWithA2xxStatus. "update failed (status 200)" refutes
// itself, and the repo removed the same class of nonsense once before when
// statusPhrase stopped printing "status 0". Asserted across every builder and
// every accepted answer at once so a sixth builder cannot reintroduce it
// quietly.
func TestUpdateNeverSaysFailedWithA2xxStatus(t *testing.T) {
	for _, uc := range updateCases() {
		for _, ans := range unreadableAnswers {
			c, _ := unreadableUpdateFake(t, ans.status, ans.body, false)
			res, _ := uc.call(c)
			msg := pyStr(res["error"])
			for _, bad := range []string{"update failed (status 200)", "update failed (status 201)",
				"update failed (status 202)", "update failed (status 204)"} {
				if strings.Contains(msg, bad) {
					t.Fatalf("%s/%s produced %q", uc.name, ans.name, msg)
				}
			}
		}
	}
}

// TestUpdateUnreadableAfterPatchThenPut. A 405 sends the builder round again as
// a PUT; the reported method must be the one that actually landed, or the audit
// row names a request that never happened.
func TestUpdateUnreadableAfterPatchThenPut(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
	}{{"PUT answers 204", 204}, {"PUT answers an empty 200", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			c, writes := unreadableUpdateFake(t, tc.status, "", true)
			res, status := c.SubnetUpdate(M{"id": "ipam/subnet/s-1", "name": "n", "dry": false})
			if res[UpdatedUnreadableKey] != true {
				t.Fatalf("not marked unconfirmed after the PUT fallback: %v", res)
			}
			if res["method"] != "PUT" {
				t.Fatalf("method = %v, want PUT — the PATCH was refused 405", res["method"])
			}
			if *writes != 2 {
				t.Fatalf("%d writes, want 2 (PATCH then PUT)", *writes)
			}
			if status != 200 {
				t.Fatalf("status = %d, want 200", status)
			}
		})
	}
}

// TestUpdateDryRunIsUntouched. A preview sends nothing upstream, so it can never
// reach this outcome — stated as a test because the new arm sits on the same
// return path.
func TestUpdateDryRunIsUntouched(t *testing.T) {
	c, writes := unreadableUpdateFake(t, 204, "", false)
	res, status := c.SubnetUpdate(M{"id": "ipam/subnet/s-1", "name": "n", "dry": true})
	if res["dry_run"] != true || res["ok"] != true || status != 200 {
		t.Fatalf("= (%v, %d), want an ordinary preview", res, status)
	}
	if res[UpdatedUnreadableKey] != nil {
		t.Fatalf("a preview was marked unconfirmed: %v", res)
	}
	if *writes != 0 {
		t.Fatalf("%d upstream writes on a dry run, want 0", *writes)
	}
}
