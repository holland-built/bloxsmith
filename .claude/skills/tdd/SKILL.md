---
name: tdd
description: Vertical-slice TDD. Use when writing tests or implementing new features. Forbids writing all tests first then all code ("horizontal slicing"). Mandates one test → one implementation → one green bar → repeat. Activate on "/tdd", "write tests first", "TDD this", "test-driven", "implement with tests".
user-invocable: true
argument-hint: "[describe the feature or function to implement]"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
---

Implement using vertical-slice TDD. Target: $ARGUMENTS

## The rule

**Do NOT write all tests first, then all code.** That is horizontal slicing — it verifies imagined behavior and produces a wall of red that gives no feedback until everything is done.

**Do this instead — one vertical slice at a time:**

```
1. Write ONE failing test for the smallest useful behavior
2. Run it → confirm it fails (red)
3. Write the minimum code to make it pass
4. Run it → confirm it passes (green)
5. Refactor if needed (keep green)
6. Repeat from 1 for the next behavior
```

Each slice = one test + one implementation + one green bar.

---

## Before writing any test

1. Read the target code in `index.html` (React components) or `server.py` (API routes)
2. Identify the smallest useful behavior to test first (the "tracer bullet")
3. State it in one sentence: "Given X, when Y, then Z"

---

## Running tests

For server-side Python tests:
```bash
python -m pytest test_regression.py -v -k "<test-name>"
```

Run the full suite to check for regressions:
```bash
python -m pytest test_regression.py -v
```

For React component behavior, use headless Chrome to observe UI state:
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --window-size=1440,900 \
  --screenshot=_test.png "http://localhost:8080"
```

---

## When a test fails unexpectedly

Stop. Don't write more tests. Use `/diagnose` — build the feedback loop, then fix the root cause.

---

## Done when

Every behavior specified in $ARGUMENTS has a passing test. No test verifies behavior that wasn't requested. The diff contains only the new test + the implementation — nothing else.
