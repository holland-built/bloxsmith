---
name: prove
description: Prove — with real, observed evidence — that a feature is actually implemented and working, rather than just asserting it is. Use this whenever the user wants proof/confirmation that something works: "prove it works", "show me it's done", "verify this feature", "confirm it actually works", "did you really finish X", "test it and show me", or any moment where you're about to claim a feature is complete and need to back that claim with evidence instead of optimism. For UI features: headless Chrome screenshot + open in browser. For backend features: curl the real server. Trigger proactively before declaring any non-trivial feature "done".
user-invocable: true
argument-hint: "[describe the feature to prove]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
---

# Prove It Works

The job here is to *prove*, not to *claim*. The difference matters: "I implemented the alert badge and it should work" is a claim. "I hotpatched the container, opened the dashboard, and here's the screenshot showing the amber badge on the subnet row" is proof.

Adopt an adversarial stance toward your own work. Your goal is not to confirm you succeeded; it's to *try to catch yourself failing*.

## The core loop

1. **Pin down the claim.** State precisely what "working" means — the specific user-visible behavior(s) that must hold.

2. **Re-read your own implementation.** Before touching the running app, look at the code with fresh, skeptical eyes. Trace the actual path the feature takes. Look for: wrong event handler, state that never updates, API route missing, JSX not rendered.

3. **Run the real thing and observe it.**
   - **UI feature → headless Chrome screenshot:**
     ```bash
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
       --headless --disable-gpu --window-size=1440,900 \
       --screenshot=_proof.png "http://localhost:8080"
     ```
     Then read `_proof.png` and analyze what's on screen. A screenshot you don't analyze is not evidence.
   - **API / backend feature → curl the real server:**
     ```bash
     curl -s http://localhost:8080/api/<endpoint> | python3 -m json.tool
     ```
   - **Regression tests → run pytest:**
     ```bash
     python -m pytest test_regression.py -v
     ```
   Clean up `_proof.png` after reporting.

4. **Test the edges, not just the happy path.** Happy path + at least one failure/boundary case.

5. **Report evidence honestly.** What you claimed, what you did, what you observed. Clear verdict. No reassurance without evidence.

## What counts as sufficient evidence

- You **observed** the behavior (saw it on screen / saw real output), not reasoned it should work.
- Evidence is **specific and verifiable** — "screenshot shows the amber bar with phase text 'Pulling new image…' and elapsed timer '1m 23s'" beats "looks good".
- **Important paths covered** including at least one edge case.
- Any gap is **stated plainly**.

## If you find it doesn't work

Report what broke with evidence, fix it, re-run the loop, prove the fix. Do not announce success on a feature you haven't seen working.
