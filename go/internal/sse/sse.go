// Package sse ports server.py's text/event-stream progress streams (the emit()
// closures at server.py:5453/5518/5569/5634/5687). Each streaming route sends
// the same headers Python sends, then writes one `data: <json>\n\n` frame per
// event and flushes, exactly matching what the frontend EventSource parses.
// Python emits only `data:` frames (no `event:` field), so this does too.
package sse

import (
	"encoding/json"
	"net/http"
)

// Emit writes one SSE frame. A disconnected client is swallowed (Python's
// `except Exception: pass` — nothing to recover mid-stream).
type Emit func(obj map[string]any)

// Start sends the SSE response headers (server.py:5446-5451) and returns an Emit
// closure bound to the flushing writer. cors sets the reflected CORS origin
// header before the status line, mirroring self._send_cors_origin(). ok is false
// when the ResponseWriter cannot stream (no http.Flusher) — the caller should
// have already returned any auth error as JSON before calling Start.
func Start(w http.ResponseWriter, cors func()) (Emit, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	if cors != nil {
		cors()
	}
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	return func(obj map[string]any) {
		data, err := json.Marshal(obj)
		if err != nil {
			return
		}
		if _, err := w.Write([]byte("data: ")); err != nil {
			return
		}
		if _, err := w.Write(data); err != nil {
			return
		}
		if _, err := w.Write([]byte("\n\n")); err != nil {
			return
		}
		flusher.Flush()
	}, true
}
