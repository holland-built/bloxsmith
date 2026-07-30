package store

import (
	"os"
	"sync"
	"testing"
)

// This file exercises the REAL ai_budget.json persistence layer (AddTokens /
// RecordLimit / Status on *Store), not the internal/ai package's fakeBudget
// stand-in. Everything here is modelled on the alert/first-seen conventions
// above: newTestStore(t) for a throwaway stateDir, atomicWriteJSON to seed a
// specific on-disk state, and asserting on the typed struct fields rather
// than any formatted string.

// TestBudget_PersistsAcrossRestart is the entire reason this data lives on
// disk instead of in a package-level var: the dashboard process restarts
// (deploys, crashes, launchd relaunch) and must not forget how much of the
// daily cap has already been spent. A brand-new *Store constructed over the
// SAME stateDir stands in for that restart — if it read back zero, an
// operator would get no near-limit warning until the account's real 429 hit,
// which is exactly the blind spot this feature exists to close.
func TestBudget_PersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	s1 := New(dir)
	s1.AddTokens(4200)

	s2 := New(dir) // simulates process restart: fresh Store, same files on disk
	tokens, _, _, hasLimit := s2.Status()
	if tokens != 4200 {
		t.Fatalf("tokens after restart = %d, want 4200 (persisted spend lost across restart)", tokens)
	}
	if hasLimit {
		t.Fatalf("hasLimit = true after restart, want false: AddTokens must never invent a limit")
	}
}

// TestBudget_NeverInventsLimit pins the exact defect the task description
// says a mutation defeated: with no 429 ever seen, Status must report
// hasLimit=false (the pointer-absence state), not a fabricated default. This
// asserts on the bool/int pair directly — not a formatted string — because a
// string assertion is exactly what let a fabricated default slip through
// before.
func TestBudget_NeverInventsLimit(t *testing.T) {
	s := newTestStore(t)

	// Spend tokens repeatedly; volume of activity must never manufacture a
	// limit that was never actually told to us by the provider.
	s.AddTokens(10)
	s.AddTokens(90000)

	_, _, limitTokens, hasLimit := s.Status()
	if hasLimit {
		t.Fatalf("hasLimit = true with no RecordLimit ever called; limitTokens=%d — a limit was invented", limitTokens)
	}
}

// TestBudget_LimitOnlyAfterRecordLimit: a limit appears ONLY once RecordLimit
// is called, and the value reported back is exactly what was recorded — never
// rounded, defaulted, or guessed at. RecordLimit's own doc comment says it
// must only ever be called with a number read verbatim out of a 429 body;
// this test is the contract that guarantees Status doesn't mangle that value
// on the way back out.
func TestBudget_LimitOnlyAfterRecordLimit(t *testing.T) {
	s := newTestStore(t)

	if _, _, _, hasLimit := s.Status(); hasLimit {
		t.Fatalf("hasLimit = true before RecordLimit was ever called")
	}

	s.RecordLimit(123457) // an odd, non-round number: proves no rounding/defaulting
	_, _, limitTokens, hasLimit := s.Status()
	if !hasLimit {
		t.Fatalf("hasLimit = false after RecordLimit, want true")
	}
	if limitTokens != 123457 {
		t.Fatalf("limitTokens = %d, want exactly 123457 (the recorded value, unmodified)", limitTokens)
	}
}

// TestBudget_AccumulatesAcrossCalls: repeated AddTokens must sum, not
// overwrite. An overwrite bug would make the running count reflect only the
// last chat completion instead of the day's total, silently hiding real
// spend from the near-limit warning.
func TestBudget_AccumulatesAcrossCalls(t *testing.T) {
	s := newTestStore(t)

	s.AddTokens(100)
	s.AddTokens(250)
	tokens, _ := s.AddTokens(7)

	if tokens != 357 {
		t.Fatalf("tokens after three AddTokens calls = %d, want 100+250+7=357 (overwrite instead of sum)", tokens)
	}
	got, _, _, _ := s.Status()
	if got != 357 {
		t.Fatalf("Status tokens = %d, want 357", got)
	}
}

// TestBudget_UTCDayRollover: a count written on a stale calendar day must not
// be reported as today's — a server left idle across UTC midnight must not
// show yesterday's leftover spend and falsely warn near-limit on a budget
// that actually just reset. But the limit itself is a property of the
// account/plan, not of the day, so — unlike the token count — it must
// SURVIVE the rollover; forgetting the limit on every UTC midnight would mean
// re-losing the warning until the next real 429, once a day, forever.
func TestBudget_UTCDayRollover(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)

	// Seed a stale day's file directly (bypassing AddTokens/RecordLimit,
	// which always stamp today) to simulate "yesterday's" leftover state.
	limit := 50000
	stale := aiBudgetState{
		Day:         "2000-01-01",
		Tokens:      9999,
		LimitTokens: &limit,
		LimitSeenAt: "2000-01-01T00:00:00Z",
	}
	if err := atomicWriteJSON(s.aiBudgetFile(), stale); err != nil {
		t.Fatal(err)
	}

	tokens, day, limitTokens, hasLimit := s.Status()
	if tokens != 0 {
		t.Fatalf("tokens = %d, want 0: yesterday's count must not be reported as today's", tokens)
	}
	if day == "2000-01-01" {
		t.Fatalf("day still reads as the stale day, want today's UTC date")
	}
	if !hasLimit || limitTokens != 50000 {
		t.Fatalf("hasLimit=%v limitTokens=%d, want the limit to survive the day rollover (it's an account property, not a per-day one)", hasLimit, limitTokens)
	}

	// AddTokens must independently reset the count (not just Status masking
	// it) and must also carry the limit forward when it rewrites the file.
	newTotal, newDay := s.AddTokens(50)
	if newTotal != 50 {
		t.Fatalf("tokens after AddTokens post-rollover = %d, want 50 (stale 9999 must not carry forward)", newTotal)
	}
	if newDay == "2000-01-01" {
		t.Fatalf("AddTokens did not roll the day forward")
	}
	_, _, limitTokens2, hasLimit2 := s.Status()
	if !hasLimit2 || limitTokens2 != 50000 {
		t.Fatalf("limit lost after AddTokens rolled the day over: hasLimit=%v limitTokens=%d", hasLimit2, limitTokens2)
	}
}

// TestBudget_ConcurrentAddTokens hammers AddTokens from many goroutines
// sharing one *Store, the same way multiple concurrent dashboard queries
// would. budgetMu exists specifically to serialize the read-modify-write
// around ai_budget.json; if that lock were ever removed or narrowed, this
// test (run with -race, per the task) would catch both the data race and the
// lost-update: two goroutines reading the same on-disk count before either
// writes back would silently drop one side's tokens, under-reporting real
// spend to the operator.
func TestBudget_ConcurrentAddTokens(t *testing.T) {
	s := newTestStore(t)

	const goroutines = 50
	const perGoroutine = 37
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			s.AddTokens(perGoroutine)
		}()
	}
	wg.Wait()

	want := goroutines * perGoroutine
	got, _, _, _ := s.Status()
	if got != want {
		t.Fatalf("tokens after %d concurrent AddTokens(%d) = %d, want %d (a lost update dropped some writers' tokens)", goroutines, perGoroutine, got, want)
	}
}

// TestBudget_MissingFileReadsAsCleanZero: no ai_budget.json has ever been
// written (genuine first run, same shape as first_seen's missing-file case
// above). This must behave as a normal empty state, not an error — an
// operator's very first query must not fail or panic just because no budget
// file exists yet.
func TestBudget_MissingFileReadsAsCleanZero(t *testing.T) {
	s := newTestStore(t) // fresh TempDir: no ai_budget.json present

	tokens, day, limitTokens, hasLimit := s.Status()
	if tokens != 0 || hasLimit || limitTokens != 0 {
		t.Fatalf("fresh store Status = tokens=%d day=%s limitTokens=%d hasLimit=%v, want a clean zero state", tokens, day, limitTokens, hasLimit)
	}
	if day == "" {
		t.Fatalf("day must still be reported as today's UTC date even with no file on disk")
	}
}

// TestBudget_CorruptFileDoesNotPanicOrLie: garbage bytes where ai_budget.json
// should be (disk corruption, a killed write, manual tampering) must not
// crash the status/query path, and — the part a naive "ignore decode errors"
// fix could get wrong — must not silently resurface some other stale number.
// It must degrade to the same clean-zero state as a missing file, never a
// half-decoded or wrong count.
func TestBudget_CorruptFileDoesNotPanicOrLie(t *testing.T) {
	s := newTestStore(t)
	if err := os.WriteFile(s.aiBudgetFile(), []byte("not valid json{{{"), 0o600); err != nil {
		t.Fatal(err)
	}

	tokens, _, limitTokens, hasLimit := s.Status()
	if tokens != 0 || hasLimit || limitTokens != 0 {
		t.Fatalf("corrupt file Status = tokens=%d limitTokens=%d hasLimit=%v, want a clean zero state, not a wrong/stale number", tokens, limitTokens, hasLimit)
	}

	// Must also not panic or misbehave on the write path: AddTokens has to
	// recover from the corrupt read and start counting cleanly from here.
	newTotal, _ := s.AddTokens(5)
	if newTotal != 5 {
		t.Fatalf("AddTokens after corrupt file = %d, want 5 (garbage must not be added to or mistaken for a real count)", newTotal)
	}
}
