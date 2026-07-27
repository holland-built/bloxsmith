package dashboard

// Covers the attack-surface tri-state availability (ok / metadata-degraded /
// unavailable) added to CSPExposures / CSPExposedHostnames / CSPExposedIPs:
// a well-formed total is trusted, an inconsistent or missing total degrades
// to "metadata-degraded" with no total emitted (never the row count
// substituted in), and an upstream fetch failure (e.g. the real 429 the
// hostnames endpoint returns once it crosses Infoblox's 4 MiB gRPC cap)
// yields "unavailable" with an operator-safe reason and no raw upstream text.

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const grpcRawDetail = "grpc: trying to send message larger than max (4582036 vs. 4194304)"

func newExposuresBody(exposureCount int, extra string) string {
	items := make([]string, 0, exposureCount)
	for i := 0; i < exposureCount; i++ {
		items = append(items, fmt.Sprintf(`{"id":%d,"title":"e%d","severity":"high"}`, i, i))
	}
	return fmt.Sprintf(`{"exposures":[%s]%s}`, strings.Join(items, ","), extra)
}

func TestCSPExposures_WellFormedTotal_YieldsOkWithTotal(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(newExposuresBody(3, `,"total_count":121634,"has_more":true`)))
	})

	got := s.CSPExposures()

	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok", got["availability"])
	}
	if got["status"] != "ok" {
		t.Fatalf("status = %v, want ok", got["status"])
	}
	data := got["data"].(map[string]any)
	if data["count"] != 3 {
		t.Fatalf("count = %v, want 3", data["count"])
	}
	if data["total_available"] != 121634 {
		t.Fatalf("total_available = %v, want 121634", data["total_available"])
	}
}

func TestCSPExposures_MissingTotalCount_YieldsMetadataDegradedNoTotal(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(newExposuresBody(3, "")))
	})

	got := s.CSPExposures()

	if got["availability"] != "metadata-degraded" {
		t.Fatalf("availability = %v, want metadata-degraded", got["availability"])
	}
	if got["status"] != "ok" {
		t.Fatalf("status = %v, want ok (feed itself is healthy)", got["status"])
	}
	data := got["data"].(map[string]any)
	if data["count"] != 3 {
		t.Fatalf("count = %v, want 3", data["count"])
	}
	if _, has := data["total_available"]; has {
		t.Fatalf("total_available must be absent, got %v", data["total_available"])
	}
}

func TestCSPExposures_TotalSmallerThanReturned_YieldsMetadataDegraded(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 5 rows returned but total_count claims only 3 — internally inconsistent.
		_, _ = w.Write([]byte(newExposuresBody(5, `,"total_count":3,"has_more":false`)))
	})

	got := s.CSPExposures()

	if got["availability"] != "metadata-degraded" {
		t.Fatalf("availability = %v, want metadata-degraded", got["availability"])
	}
	data := got["data"].(map[string]any)
	if _, has := data["total_available"]; has {
		t.Fatalf("total_available must be absent, got %v", data["total_available"])
	}
}

func TestCSPExposures_HasMoreTrueButTotalEqualsReturned_YieldsMetadataDegraded(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// has_more says there's another page, but total_count claims we've
		// already seen everything — contradicts itself.
		_, _ = w.Write([]byte(newExposuresBody(3, `,"total_count":3,"has_more":true`)))
	})

	got := s.CSPExposures()

	if got["availability"] != "metadata-degraded" {
		t.Fatalf("availability = %v, want metadata-degraded", got["availability"])
	}
	data := got["data"].(map[string]any)
	if _, has := data["total_available"]; has {
		t.Fatalf("total_available must be absent, got %v", data["total_available"])
	}
}

func TestCSPExposedHostnames_429_YieldsUnavailableWithReasonNoRows(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"error":[{"message":%q}]}`, grpcRawDetail)))
	})

	got := s.CSPExposedHostnames()

	if got["availability"] != "unavailable" {
		t.Fatalf("availability = %v, want unavailable", got["availability"])
	}
	if got["status"] != "error" {
		t.Fatalf("status = %v, want error", got["status"])
	}
	reason, _ := got["reason"].(string)
	if reason == "" {
		t.Fatalf("reason must be present and non-empty")
	}
	data := got["data"].(map[string]any)
	if len(data) != 0 {
		t.Fatalf("data must be empty on unavailable, got %v", data)
	}
}

func TestCSPExposedHostnames_RawGrpcStringNeverInResponse(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"error":[{"message":%q}]}`, grpcRawDetail)))
	})

	got := s.CSPExposedHostnames()

	dump := fmt.Sprintf("%v", got)
	if strings.Contains(dump, "grpc: trying to send message larger than max") {
		t.Fatalf("raw grpc detail leaked into response: %s", dump)
	}
}

func TestCSPExposedIPs_WellFormedTotal_YieldsOk(t *testing.T) {
	s, _ := newRestTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ip_addresses":["1.1.1.1","2.2.2.2"],"total_count":2,"has_more":false}`))
	})

	got := s.CSPExposedIPs()

	if got["availability"] != "ok" {
		t.Fatalf("availability = %v, want ok", got["availability"])
	}
	data := got["data"].(map[string]any)
	if data["total_available"] != 2 {
		t.Fatalf("total_available = %v, want 2", data["total_available"])
	}
}
