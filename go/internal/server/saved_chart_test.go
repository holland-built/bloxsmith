package server

import (
	"net/http/httptest"
	"testing"

	"bloxsmith/internal/config"
	"bloxsmith/internal/store"
)

// A chart saved from Build a chart is a view named __chart_<id>. Only those
// names are checked, and only against the builder's own allow-list; every
// other view is stored exactly as before.

func chartDeps(t *testing.T) *Deps {
	t.Helper()
	return &Deps{Cfg: &config.Config{Port: "8080"}, Store: store.New(t.TempDir())}
}

func saveView(t *testing.T, d *Deps, body map[string]any) (int, map[string]any) {
	t.Helper()
	rr := httptest.NewRecorder()
	d.viewWrite(rr, httptest.NewRequest("POST", "/api/views", nil), body)
	return rr.Code, decodeBody(t, rr)
}

func chartBody(name string, chart map[string]any) map[string]any {
	return map[string]any{"name": name, "chart": chart}
}

func goodChart() map[string]any {
	return map[string]any{
		"v": float64(1), "title": "Top domains", "tab": "dns",
		"picks": map[string]any{"count": "dns", "split": "domain", "window": "7d", "over": "none", "top": float64(10)},
	}
}

func TestSavedChart_GoodPicksAreStoredAndReadBack(t *testing.T) {
	d := chartDeps(t)
	if code, body := saveView(t, d, chartBody("__chart_k3x9q2m7", goodChart())); code != 200 {
		t.Fatalf("status = %d (%v), want 200", code, body)
	}
	got := d.Store.ViewRead("__chart_k3x9q2m7")
	chart, _ := got["chart"].(map[string]any)
	if chart["title"] != "Top domains" || chart["tab"] != "dns" {
		t.Fatalf("read back %v", got)
	}
	if p, _ := chart["picks"].(map[string]any); p["split"] != "domain" || p["top"] != float64(10) {
		t.Fatalf("picks read back as %v", chart["picks"])
	}
}

func TestSavedChart_BadChartsAreRefused(t *testing.T) {
	with := func(k string, v any) map[string]any {
		c := goodChart()
		c[k] = v
		return c
	}
	picks := func(k string, v any) map[string]any {
		c := goodChart()
		p := map[string]any{}
		for pk, pv := range c["picks"].(map[string]any) {
			p[pk] = pv
		}
		p[k] = v
		c["picks"] = p
		return c
	}
	for name, body := range map[string]map[string]any{
		"picks outside the allow-list": chartBody("__chart_k3x9q2m7", picks("split", "tclass")),
		"an unknown count":             chartBody("__chart_k3x9q2m7", picks("count", "cpu")),
		"a top the menu never offers":  chartBody("__chart_k3x9q2m7", picks("top", float64(1000))),
		"no chart at all":              {"name": "__chart_k3x9q2m7"},
		"no title":                     chartBody("__chart_k3x9q2m7", with("title", "  ")),
		"a title too long":             chartBody("__chart_k3x9q2m7", with("title", string(make([]byte, 81)))),
		"a page it can't go on":        chartBody("__chart_k3x9q2m7", with("tab", "provision")),
		"an unknown version":           chartBody("__chart_k3x9q2m7", with("v", float64(2))),
		"an id that is a slug":         chartBody("__chart_Top domains", goodChart()),
		"an id too short to be random": chartBody("__chart_ab", goodChart()),
	} {
		if code, _ := saveView(t, chartDeps(t), body); code != 400 {
			t.Errorf("%s: status = %d, want 400", name, code)
		}
	}
}

// TestSavedChart_OrdinaryViewsAreUntouched: a layout saves as it always has,
// and a stray chart field on it is not kept.
func TestSavedChart_OrdinaryViewsAreUntouched(t *testing.T) {
	dp := chartDeps(t)
	layout := map[string]any{
		"name":   "__layout_dns",
		"order":  []any{"dns-zones", "dns-rpz"},
		"layout": map[string]any{"version": float64(1), "spans": map[string]any{}, "hidden": []any{}},
		"chart":  map[string]any{"anything": true},
	}
	if code, body := saveView(t, dp, layout); code != 200 {
		t.Fatalf("status = %d (%v), want 200", code, body)
	}
	got := dp.Store.ViewRead("__layout_dns")
	if _, ok := got["chart"]; ok {
		t.Fatalf("a layout kept a chart field: %v", got)
	}
	if o, _ := got["order"].([]any); len(o) != 2 || o[0] != "dns-zones" {
		t.Fatalf("layout order read back as %v", got["order"])
	}
}
