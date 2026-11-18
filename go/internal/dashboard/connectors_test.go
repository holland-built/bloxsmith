package dashboard

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// Rows in the shape GET /api/cloud_discovery/v2/providers returned on the live
// tenant (2026-11-17), cut down to the fields the panel reads.
func connectorRows() []any {
	row := func(name, typ, status string, disabled bool, last, msg string) any {
		return map[string]any{
			"name": name, "provider_type": typ, "status": status, "is_disabled": disabled,
			"last_sync": last, "status_message": msg, "source_configs": []any{map[string]any{"big": "nested"}},
		}
	}
	return []any{
		row("Azure_AMS", "Microsoft Azure", "Synced", false, "2026-11-18T04:09:08.602008Z", "Sync completed successfully"),
		row("jm_AWS_discovery", "Amazon Web Services", "Disabled", true, "2024-03-04T15:46:49.381267Z", ""),
		row("rcuadra_azure", "Microsoft Azure", "partiallysynced", false, "2026-11-18T04:07:13Z",
			"Asset Discovery and sync completed successfully\nDNS sync has failed partially:Errors occurred"),
		row("cw_aws_demo", "Amazon Web Services", "Error", false, "2026-11-18T03:43:12Z",
			"The provided credentials have expired. Please update the credentials."),
		row("AWS_DJT", "Amazon Web Services", "Error", false, "2026-11-18T03:13:51Z", "Access denied to resource. Please check your permissions."),
		row("new_one", "Google Cloud Platform", "InProgress", false, "", ""),
		row("odd_one", "Meraki", "SomethingNew", false, "", ""),
	}
}

func TestConnectorState_PlainWordsForEachStatus(t *testing.T) {
	cases := []struct {
		status   string
		disabled bool
		state    string
		word     string
	}{
		{"Error", false, "failing", "Failing"},
		{"Failed", false, "failing", "Failing"},
		{"partiallysynced", false, "partial", "Partly working"},
		{"InProgress", false, "syncing", "Syncing"},
		{"Synced", false, "ok", "Working"},
		{"Disabled", true, "off", "Turned off"},
		// Turned off wins over whatever the last run said.
		{"Error", true, "off", "Turned off"},
		{"SomethingNew", false, "unknown", "SomethingNew"},
		{"", false, "unknown", "Unknown"},
	}
	for _, c := range cases {
		state, word := connectorState(c.status, c.disabled)
		if state != c.state || word != c.word {
			t.Errorf("connectorState(%q, %v) = %q, %q; want %q, %q", c.status, c.disabled, state, word, c.state, c.word)
		}
	}
}

func TestAssembleConnectors_FailingFirstThenByName(t *testing.T) {
	got := assembleConnectors(connectorRows(), nil)
	if got["availability"] != "ok" || got["truncated"] != false {
		t.Fatalf("payload %v", got)
	}
	list := got["connectors"].([]map[string]any)
	var order []string
	for _, c := range list {
		order = append(order, c["name"].(string))
	}
	want := "AWS_DJT,cw_aws_demo,rcuadra_azure,odd_one,new_one,Azure_AMS,jm_AWS_discovery"
	if strings.Join(order, ",") != want {
		t.Errorf("order %s\nwant  %s", strings.Join(order, ","), want)
	}
	first := list[0]
	for k, v := range map[string]any{
		"type": "Amazon Web Services", "status": "Error", "state": "failing", "word": "Failing",
		"last_sync": "2026-11-18T03:13:51Z", "message": "Access denied to resource. Please check your permissions.",
	} {
		if first[k] != v {
			t.Errorf("%s = %v, want %v", k, first[k], v)
		}
	}
	if _, ok := first["source_configs"]; ok {
		t.Error("the nested config should not reach the browser")
	}
	counts := got["counts"].(map[string]int)
	wantCounts := map[string]int{"failing": 2, "partial": 1, "unknown": 1, "syncing": 1, "ok": 1, "off": 1}
	for k, v := range wantCounts {
		if counts[k] != v {
			t.Errorf("counts[%s] = %d, want %d", k, counts[k], v)
		}
	}
}

func TestAssembleConnectors_AFailedReadIsNotAnEmptyList(t *testing.T) {
	got := assembleConnectors(nil, errNotAnAddress)
	if got["availability"] != "error" {
		t.Fatalf("payload %v", got)
	}
	if r, _ := got["reason"].(string); r == "" {
		t.Error("no reason")
	}
	if got := assembleConnectors([]any{}, nil); got["availability"] != "ok" || len(got["connectors"].([]map[string]any)) != 0 {
		t.Errorf("a tenant with no connections: %v", got)
	}
}

func TestAssembleConnectors_AFullPageSaysThereMayBeMore(t *testing.T) {
	rows := make([]any, connectorLimit)
	for i := range rows {
		rows[i] = map[string]any{"name": "c", "status": "Synced"}
	}
	if got := assembleConnectors(rows, nil); got["truncated"] != true {
		t.Errorf("truncated %v", got["truncated"])
	}
}

func TestFetchConnectorHealth_ReadsTheWholeRecordAndCachesOnlySuccess(t *testing.T) {
	var calls atomic.Int32
	fail := atomic.Bool{}
	fail.Store(true)
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/api/cloud_discovery/v2/providers" {
			t.Errorf("path %s", r.URL.Path)
		}
		// _fields is measured to break this endpoint: with it, every
		// connection's status read "Disabled" and last_sync went missing.
		if r.URL.Query().Has("_fields") {
			t.Error("_fields must not be sent")
		}
		if r.URL.Query().Get("_limit") != "200" {
			t.Errorf("_limit %q", r.URL.Query().Get("_limit"))
		}
		if fail.Load() {
			w.WriteHeader(502)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"name":"a","provider_type":"Amazon Web Services","status":"Error","is_disabled":false}]}`))
	})
	if got := s.FetchConnectorHealth(context.Background()); got["availability"] != "error" {
		t.Fatalf("payload %v", got)
	}
	fail.Store(false)
	got := s.FetchConnectorHealth(context.Background())
	if got["availability"] != "ok" || len(got["connectors"].([]map[string]any)) != 1 {
		t.Fatalf("payload %v; a failure must not be cached", got)
	}
	s.FetchConnectorHealth(context.Background())
	if n := calls.Load(); n != 2 {
		t.Errorf("%d calls, want 2", n)
	}
}
