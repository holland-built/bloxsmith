package server

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"bloxsmith/internal/demo"
	"bloxsmith/internal/runs"
)

// WORK GATE. An update must never swap the binary under a running change, so
// this counts every change in flight and can close to new ones.
//
// Closing and checking the count happen under one lock. Nothing can start
// between "nothing is running" and "nothing new may start". The gate then stays
// closed through the restart, or reopens if the update fails. Overnight updates
// and Update now both use it.
type WorkGate struct {
	mu     sync.Mutex
	active int
	closed bool
}

// Enter counts one piece of work. It reports false when the gate is closed.
// The returned function ends the count and is safe to call once.
func (g *WorkGate) Enter() (func(), bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return func() {}, false
	}
	g.active++
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.active--
			g.mu.Unlock()
		})
	}, true
}

// closeIfIdle closes the gate only when nothing is running.
func (g *WorkGate) closeIfIdle() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active > 0 {
		return false
	}
	g.closed = true
	return true
}

func (g *WorkGate) reopen() {
	g.mu.Lock()
	g.closed = false
	g.mu.Unlock()
}

func (d *Deps) workGate() *WorkGate {
	d.workOnce.Do(func() {
		if d.Work == nil {
			d.Work = &WorkGate{}
		}
	})
	return d.Work
}

// goCounted runs fn in the background and counts it until it returns. It
// reports false, without running fn, when the gate is closed.
func (d *Deps) goCounted(fn func()) bool {
	release, ok := d.workGate().Enter()
	if !ok {
		return false
	}
	go func() {
		defer release()
		fn()
	}()
	return true
}

// CloseForUpdate closes admission and checks for running work. It returns ""
// with the gate closed, or the reason it is busy with the gate open again.
func (d *Deps) CloseForUpdate() string {
	g := d.workGate()
	if !g.closeIfIdle() {
		return "a change was running"
	}
	if why := d.runRecordsBusy(); why != "" {
		g.reopen()
		return why
	}
	return ""
}

// ReopenAfterUpdate lets work start again after an update that did not restart.
func (d *Deps) ReopenAfterUpdate() { d.workGate().reopen() }

// WorkRunning reports why an update should wait, or "" when nothing is running.
// It closes nothing, so Update now can answer at once without blocking work
// during the download. CloseForUpdate is still the check that protects the swap.
func (d *Deps) WorkRunning() string {
	g := d.workGate()
	g.mu.Lock()
	active := g.active
	g.mu.Unlock()
	if active > 0 {
		return "a change was running"
	}
	return d.runRecordsBusy()
}

// UpdateGate is the part of the work gate the Update now handler needs.
type UpdateGate interface {
	WorkRunning() string
	CloseForUpdate() string
	ReopenAfterUpdate()
}

type updateGateKey struct{}

// withUpdateGate hands this server's gate to the Update now handler.
func (d *Deps) withUpdateGate(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), updateGateKey{}, UpdateGate(d)))
}

// UpdateGateFrom returns the gate for this request, or nil if it has none.
func UpdateGateFrom(ctx context.Context) UpdateGate {
	g, _ := ctx.Value(updateGateKey{}).(UpdateGate)
	return g
}

// runRecordsBusy reads both run stores. A record that cannot be read counts as
// busy, because it may belong to work still running.
func (d *Deps) runRecordsBusy() string {
	if l := d.ledger(); l != nil {
		rs, err := l.List()
		if err != nil {
			return "a job record could not be read"
		}
		for _, r := range rs {
			if r.Status == runs.Building || r.Status == runs.Removing {
				return "a job was still running"
			}
		}
	}
	if strings.TrimSpace(d.StateDir) == "" {
		return ""
	}
	store := d.demoStore()
	live, err := store.Live()
	if err != nil {
		return "a demo server record could not be read"
	}
	if !demoRunActive(live) {
		return ""
	}
	// A crash leaves its lock behind, so startup recovery can miss the run.
	// Both callers have already seen no work running in this process, and
	// Recover changes nothing while a lock under two hours old exists.
	_ = store.Recover(time.Now)
	live, err = store.Live()
	if err != nil {
		return "a demo server record could not be read"
	}
	if demoRunActive(live) {
		return "a demo server was still being built or removed"
	}
	return ""
}

func demoRunActive(live []demo.Run) bool {
	for _, r := range live {
		if r.Status == "building" || r.Status == "removing" {
			return true
		}
	}
	return false
}

// countsAsWork reports whether this request must hold the gate open: a live
// provisioning or teardown stream, or any state-changing verb. Previews, reads,
// the update routes and vault lock and unlock do not count.
func countsAsWork(r *http.Request, path string) bool {
	if !strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/api/update/") {
		return false
	}
	if path == "/api/vault/unlock" || path == "/api/vault/lock" {
		return false
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return requestChangesTenant(r.Method, path) && !isDryPreview(r, path)
	}
	return !(requestChangesTenant(r.Method, path) && isDryPreview(r, path))
}

// withWorkGate counts a change for the whole time its handler runs, which for a
// stream is its full lifetime, and refuses new changes while the gate is closed.
func (d *Deps) withWorkGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !countsAsWork(r, r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		release, ok := d.workGate().Enter()
		if !ok {
			w.Header().Set("Retry-After", "30")
			d.json(w, r, http.StatusServiceUnavailable, map[string]any{
				"ok":    false,
				"error": "Bloxsmith is installing an update. Nothing was changed. Try again in a minute.",
			})
			return
		}
		defer release()
		next.ServeHTTP(w, r)
	})
}
