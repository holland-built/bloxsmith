package mcp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// textToolServer answers initialize, then answers every tools/call with text, and
// records the arguments of each call.
type textToolServer struct {
	mu   sync.Mutex
	args []map[string]any
}

func (s *textToolServer) start(t *testing.T, text string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			Method string `json:"method"`
			Params struct {
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &req)
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s1")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": requestID(body), "result": map[string]any{}})
		case "tools/call":
			s.mu.Lock()
			s.args = append(s.args, req.Params.Arguments)
			s.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": requestID(body),
				"result": map[string]any{"content": []map[string]any{{"text": text}}}})
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// Python writes a string holding an apostrophe in DOUBLE quotes. parseInline
// only knew single-quoted values, so that pair was skipped and the row came back
// without its key, as if complete: a device named "O'Brien's laptop" lost its
// name and still rendered as an asset.
func TestParseInlineReadsADoubleQuotedValue(t *testing.T) {
	rows, ok := parseInline(inlineText(t, `[{'Assets.name': "O'Brien's laptop", 'Assets.count': '5'}]`))
	if !ok {
		return // refusing the whole result is also honest
	}
	if len(rows) != 1 || rows[0]["Assets.name"] != "O'Brien's laptop" || rows[0]["Assets.count"] != "5" {
		t.Fatalf("a row that parsed must carry every key it was sent, got %v", rows)
	}
}

// Renaming "Cube__field" to "Cube.field" was done by inserting into the map being
// ranged over, so which keys got visited again was up to Go's iteration order. A
// key holding a second "__" could come out either way. Only the first "__"
// separates the cube from its field, so the answer is one value, every time.
func TestCubeKeysAreRenamedTheSameWayEveryTime(t *testing.T) {
	ts := &textToolServer{}
	srv := ts.start(t, inlineText(t, `[{'C__a__b': '1', 'C__c__d__e': '2', 'C__f': '3', 'C__g__h': '4', 'C__i__j': '5', `+
		`'C__k': '6', 'C__l__m': '7', 'C__n__o__p': '8', 'C__q__r': '9', 'C__s__t': '10'}]`))
	c := New(srv.URL+"/mcp", func() string { return "Bearer k" })
	want := map[string]any{"C.a__b": "1", "C.c__d__e": "2", "C.f": "3", "C.g__h": "4", "C.i__j": "5",
		"C.k": "6", "C.l__m": "7", "C.n__o__p": "8", "C.q__r": "9", "C.s__t": "10"}

	// Ten keys and 200 runs: the old rename put one of them wrong in about one
	// run in nine, so this fails on it every time.
	for i := 0; i < 200; i++ {
		rows, err := c.queryCubeMCP(t.Context(), "C", []string{"C.n"}, map[string]any{})
		if err != nil || len(rows) != 1 {
			t.Fatalf("setup: %v %v", rows, err)
		}
		for k, v := range want {
			if rows[0][k] != v {
				t.Fatalf("run %d: want %s=%v, got %v", i, k, v, rows[0])
			}
		}
		if len(rows[0]) != len(want) {
			t.Fatalf("run %d: want %d keys, got %v", i, len(want), rows[0])
		}
	}
}

// The 256 cap counts characters, as the Python it was ported from does. Cutting
// at byte 256 can land inside a multi-byte character and send a mangled query.
func TestSearchCapsTheQueryAtWholeCharacters(t *testing.T) {
	ts := &textToolServer{}
	srv := ts.start(t, `[]`)
	c := New(srv.URL+"/mcp", func() string { return "Bearer k" })
	if err := c.Initialize(t.Context()); err != nil {
		t.Fatal(err)
	}

	query := strings.Repeat("a", 255) + "é" + "tail"
	if _, err := c.SearchErr(t.Context(), query); err != nil {
		t.Fatal(err)
	}
	ts.mu.Lock()
	defer ts.mu.Unlock()
	got, _ := ts.args[0]["query"].(string)
	if strings.ContainsRune(got, '�') {
		t.Fatalf("the cut split a character and the query reached Infoblox mangled: ends %q", got[len(got)-6:])
	}
	if want := strings.Repeat("a", 255) + "é"; got != want {
		t.Fatalf("want the first 256 characters, got %d runes ending %q", len([]rune(got)), got[len(got)-4:])
	}
}
