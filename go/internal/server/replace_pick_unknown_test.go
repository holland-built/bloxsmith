package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// When the clean subnet's create gets no clear answer, the audit log records
// it as unknown, and the message does not say the subnet is there.
func TestReplaceSharedPick_NoClearAnswerIsAuditedAsUnknown(t *testing.T) {
	for _, st := range []int{500, 501, 502, 503, 504, 505} {
		d, logPath := newInventoryDeps(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			q := r.URL.Query()
			switch {
			case r.Method == http.MethodDelete:
				io.WriteString(w, `{}`)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/nextavailablesubnet"):
				io.WriteString(w, `{"results":[{"id":"ipam/subnet/new-1","address":"172.16.128.0","cidr":24}]}`)
			case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
				w.WriteHeader(st)
				io.WriteString(w, `{"error":"answer"}`)
			case strings.HasSuffix(r.URL.Path, "/"+uaBlockID):
				io.WriteString(w, `{"result":{"address":"172.16.128.0","cidr":21,"space":"ipam/ip_space/sp-1"}}`)
			case q.Get("_order_by") != "" && q.Get("_offset") != "0":
				io.WriteString(w, `{"results":[]}`)
			case strings.HasSuffix(r.URL.Path, "/ipam/subnet"):
				io.WriteString(w, `{"results":[`+subnetRow("other", "172.16.128.0", "ipam/ip_space/sp-2")+`],"page":{"total_size":"1"}}`)
			default:
				io.WriteString(w, `{"results":[]}`)
			}
		})
		rr := httptest.NewRecorder()
		d.provisionSubnetStream(rr, uaSubnetRequest("block="+uaBlockID+"&cidr=24&dry=0"))
		body := rr.Body.String()
		if strings.Contains(body, "still there") || !strings.Contains(body, "may have been created") {
			t.Fatalf("status %d: %s", st, body)
		}
		detail := uaOnly(t, logPath, "provision-subnet-unknown", "the clean subnet may exist")
		if detail["outcome"] != "unknown" || detail["subnet"] != "172.16.129.0" {
			t.Fatalf("status %d: audit detail = %v", st, detail)
		}
	}
}
