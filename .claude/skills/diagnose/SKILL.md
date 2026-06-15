---
name: diagnose
description: Systematic 6-phase bug diagnosis. Use when debugging any issue: reproduce → minimize → hypothesize → instrument → fix → regression-test. The leverage is phase 1 — building the right feedback loop. Activate on "diagnose", "/diagnose", "debug this", "can't figure out why", "something's broken".
user-invocable: true
argument-hint: "[describe the bug or paste the error]"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
---

Systematic bug diagnosis. Problem: $ARGUMENTS

## Phase 1 — Build a Feedback Loop (highest leverage)

Before anything else, find the fastest way to observe the bug reliably. Rank the options and pick the best available:

1. **Failing automated test** — write or find one that reproduces the bug; run it in <5s
2. **Short script** — minimal Python/bash that triggers the bug directly
3. **Curl / API call** — for server-side issues, a single command that shows the wrong behavior
4. **Dev-server + browser** — load the page, observe the symptom
5. **Log scrape** — `grep` for the error in `server.log` or container logs
6. **Manual UI steps** — last resort; describe the exact click path that triggers it

**Do not proceed to Phase 2 until the feedback loop is running.** A loop you can run in <10s is worth more than 30 minutes of reading code.

State: "Feedback loop: `<command>` → reproduces the bug with output: `<output>`"

## Phase 2 — Minimize

Strip away everything that isn't load-bearing for the bug. Goal: smallest failing case.

- Remove unrelated code paths, config, env vars
- Bisect if the bug appeared in a recent commit: `git bisect start && git bisect bad && git bisect good <hash>`
- Narrow to one file, one function, one call if possible

State the minimal reproducer before continuing.

## Phase 3 — Hypothesize

Generate 3–5 distinct hypotheses. For each:
- What would have to be true for this hypothesis to explain the bug?
- What evidence already confirms or rules it out?
- What one observation would eliminate it?

Do not pick a favorite yet. List all live hypotheses.

## Phase 4 — Instrument

Add targeted observability to distinguish between hypotheses — without changing behavior:

- `print()` / `console.log` at branch points
- Assertions that should always hold
- Read relevant config, env, and state values at the failure point
- For network bugs: log request/response headers and bodies
- For React state bugs: add `console.log` to state transitions or use React DevTools

Run the feedback loop. Eliminate hypotheses. Repeat until one survives.

## Phase 5 — Fix

Fix only the confirmed root cause. No collateral cleanup.

- State the root cause in one sentence before writing any code
- Change the minimum lines that address it
- If the fix feels large, question whether phase 3 was complete

## Phase 6 — Regression Test

Lock the bug out permanently:

- Add a test to `test_regression.py` that would have caught this bug
- Run it against the broken version (should fail), then the fixed version (should pass)

---

**Rule:** If you get stuck at any phase, go back to Phase 1 and improve the feedback loop. A better loop almost always unblocks you.
