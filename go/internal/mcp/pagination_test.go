package mcp

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

// pageResponse builds a query_stored_data-shaped JSON-RPC success envelope
// carrying n columnar rows (single "id" column, values start..start+n-1).
func pageResponse(start, n int) string {
	data := make([][]string, n)
	for i := 0; i < n; i++ {
		data[i] = []string{strconv.Itoa(start + i)}
	}
	text, _ := json.Marshal(map[string]any{
		"columns": []string{"id"},
		"data":    data,
	})
	resp := map[string]any{
		"jsonrpc": "2.0", "id": 1,
		"result": map[string]any{
			"content": []map[string]any{{"text": string(text)}},
		},
	}
	b, _ := json.Marshal(resp)
	return string(b)
}

// pagingServer returns an httptest server whose infoblox-portal_query_stored_data
// handler is driven by respond, called once per call with the 1-based call
// number. respond writes the HTTP response directly.
func pagingServer(t *testing.T, respond func(callNum int32, w http.ResponseWriter)) (*httptest.Server, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Method string `json:"method"`
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		body, _ := decodeBody(r)
		_ = json.Unmarshal(body, &req)

		if req.Method == "tools/call" && req.Params.Name == "infoblox-portal_query_stored_data" {
			n := atomic.AddInt32(&calls, 1)
			respond(n, w)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

// TestQueryAllRowsPaginatesAcrossSeveralPages verifies a clean multi-page
// pagination assembles every row with no error.
func TestQueryAllRowsPaginatesAcrossSeveralPages(t *testing.T) {
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		start := int(n-1) * pageSize
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(start, pageSize)))
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", 3*pageSize, "test")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(rows) != 3*pageSize {
		t.Fatalf("expected %d rows, got %d", 3*pageSize, len(rows))
	}
	if got := atomic.LoadInt32(calls); got != 3 {
		t.Fatalf("expected 3 query_stored_data calls, got %d", got)
	}
}

// TestQueryAllRowsShortFinalPageEndsCleanly verifies a final page shorter
// than pageSize (a genuine end of data) completes with no error — a short
// page is not a failure.
func TestQueryAllRowsShortFinalPageEndsCleanly(t *testing.T) {
	const rowCount = pageSize + 50 // page0 full, page1 short (50 rows)
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		start := int(n-1) * pageSize
		size := pageSize
		if n == 2 {
			size = 50
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(start, size)))
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", rowCount, "test")
	if err != nil {
		t.Fatalf("expected no error for a short final page, got %v", err)
	}
	if len(rows) != rowCount {
		t.Fatalf("expected %d rows, got %d", rowCount, len(rows))
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected 2 query_stored_data calls, got %d", got)
	}
}

// TestQueryAllRowsZeroRowsPageOneEndsCleanly verifies a zero-row first page
// (the parquet metadata claimed rows exist but none come back) is treated as
// a legitimate, complete, empty result — not an error. Empty must stay
// legitimate.
func TestQueryAllRowsZeroRowsPageOneEndsCleanly(t *testing.T) {
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(0, 0)))
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", 100, "test")
	if err != nil {
		t.Fatalf("expected no error for a zero-row page, got %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("expected 0 rows, got %d: %+v", len(rows), rows)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected exactly 1 query_stored_data call, got %d", got)
	}
}

// TestQueryAllRowsPage0FailureReturnsEmptyNoError locks in the preserved,
// unchanged contract for a page-0 failure: it looks identical to "no data",
// exactly as before this fix, because nothing was ever successfully read —
// there is no partial set to mislabel.
func TestQueryAllRowsPage0FailureReturnsEmptyNoError(t *testing.T) {
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", 200, "test")
	if err != nil {
		t.Fatalf("expected page-0 failure to return nil error (unchanged contract), got %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("expected 0 rows, got %d: %+v", len(rows), rows)
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("expected exactly 1 attempted call, got %d", got)
	}
}

// TestQueryAllRowsTransportFailureMidPagination is the core regression test:
// a transport error on page 2 of 3 must NOT be swallowed. The partial rows
// gathered so far must come back wrapped in ErrIncompleteRows, not silently
// presented as the complete set.
func TestQueryAllRowsTransportFailureMidPagination(t *testing.T) {
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		if n == 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		start := int(n-1) * pageSize
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(start, pageSize)))
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", 3*pageSize, "test")
	if err == nil {
		t.Fatal("expected a non-nil error for a mid-pagination transport failure")
	}
	if !errors.Is(err, ErrIncompleteRows) {
		t.Fatalf("expected errors.Is(err, ErrIncompleteRows), got %v", err)
	}
	if len(rows) != pageSize {
		t.Fatalf("expected the 1 successfully-read page (%d rows) back alongside the error, got %d", pageSize, len(rows))
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected exactly 2 attempted calls (stop at the failure), got %d", got)
	}
}

// TestQueryAllRowsDecodeFailureMidPagination is the same regression as above
// but for a malformed page body instead of a transport-level failure.
func TestQueryAllRowsDecodeFailureMidPagination(t *testing.T) {
	srv, calls := pagingServer(t, func(n int32, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if n == 2 {
			resp := map[string]any{
				"jsonrpc": "2.0", "id": 1,
				"result": map[string]any{
					"content": []map[string]any{{"text": "this is not valid json"}},
				},
			}
			b, _ := json.Marshal(resp)
			_, _ = w.Write(b)
			return
		}
		start := int(n-1) * pageSize
		_, _ = w.Write([]byte(pageResponse(start, pageSize)))
	})

	c := New(srv.URL, func() string { return "Bearer test" })
	rows, err := c.queryAllRows(t.Context(), "t.parquet", 3*pageSize, "test")
	if err == nil {
		t.Fatal("expected a non-nil error for a mid-pagination decode failure")
	}
	if !errors.Is(err, ErrIncompleteRows) {
		t.Fatalf("expected errors.Is(err, ErrIncompleteRows), got %v", err)
	}
	if len(rows) != pageSize {
		t.Fatalf("expected the 1 successfully-read page (%d rows) back alongside the error, got %d", pageSize, len(rows))
	}
	if got := atomic.LoadInt32(calls); got != 2 {
		t.Fatalf("expected exactly 2 attempted calls (stop at the failure), got %d", got)
	}
}

// TestQueryAllRowsTruncatedResultDistinguishableFromComplete is the crux of
// this fix: before it, a truncated read (partial rows, err == nil) and a
// genuinely complete read of the same size (full rows, err == nil) were
// bit-for-bit the same shape — there was no way for a caller to tell them
// apart. This proves they are now distinguishable purely via the error,
// even when the row COUNTS happen to coincide.
func TestQueryAllRowsTruncatedResultDistinguishableFromComplete(t *testing.T) {
	// A genuinely complete fetch of exactly pageSize rows (rowCount == pageSize,
	// one page, nothing left to read).
	completeSrv, _ := pagingServer(t, func(n int32, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(0, pageSize)))
	})
	completeClient := New(completeSrv.URL, func() string { return "Bearer test" })
	completeRows, completeErr := completeClient.queryAllRows(t.Context(), "t.parquet", pageSize, "test")

	// A truncated fetch that ALSO ends up with exactly pageSize rows in hand,
	// because page 2 of a 3-page fetch fails.
	truncSrv, _ := pagingServer(t, func(n int32, w http.ResponseWriter) {
		if n == 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(pageResponse(0, pageSize)))
	})
	truncClient := New(truncSrv.URL, func() string { return "Bearer test" })
	truncRows, truncErr := truncClient.queryAllRows(t.Context(), "t.parquet", 3*pageSize, "test")

	if len(completeRows) != len(truncRows) {
		t.Fatalf("test setup invalid: expected equal row counts to prove the error is the ONLY distinguishing signal, got %d vs %d", len(completeRows), len(truncRows))
	}
	if completeErr != nil {
		t.Fatalf("expected the complete fetch to have no error, got %v", completeErr)
	}
	if truncErr == nil {
		t.Fatal("expected the truncated fetch to have a non-nil error — otherwise it is indistinguishable from a complete result, which is exactly the bug")
	}
	if !errors.Is(truncErr, ErrIncompleteRows) {
		t.Fatalf("expected errors.Is(truncErr, ErrIncompleteRows), got %v", truncErr)
	}
}
