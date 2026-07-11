# Plan 013: Green the regression baseline by making two frozen-snapshot assertions structural invariants

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 61b1e6e..HEAD -- test_regression.py index.html`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

**Written against commit `61b1e6e`.**

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `61b1e6e`, 2026-07-11

## Why this matters

The regression suite is RED at HEAD. Two `FrontendStructureTests` assertions
are frozen snapshots of a UI that has since grown: `test_region_markers`
expects exactly 28 `═══` occurrences but `index.html` now has 32 (an 8th
region, `PROVISION`, was added), and `test_seven_tab_ids` expects a frozen
7-element `const TABS=[...]` literal but the app now ships 10 tabs. So
`python3 -m unittest test_regression.FrontendStructureTests` exits non-zero on
a clean checkout, and each failure diff dumps the entire ~340 KB `index.html`
string, which is unreadable. A red baseline is the worst kind of test failure:
it trains everyone to ignore the suite, so a *real* regression lands invisibly.
This is finding #1 — it must land before any other plan, because every other
plan's "verify: tests pass" gate is meaningless while the baseline is red.

The fix converts both assertions from frozen snapshots into **structural
invariants** that survive additive UI growth: region markers must be balanced
and each named region must have both a REGION and an END marker; the tab list
must *contain* the required ordered core subset rather than *equal* a frozen
literal. New regions and new tabs then auto-enroll instead of breaking CI.

## Current state

- `test_regression.py` — the suite. Two classes: `BackendTests` (line 67,
  needs a live server + tenant) and `FrontendStructureTests` (line 442, pure
  static assertions over `index.html`, no server). This plan touches ONLY the
  two failing methods inside `FrontendStructureTests` (and, in the OPTIONAL
  step, the `BackendTests` class decorator).
- `index.html` — the single-file SPA the tests read. **Do NOT modify it.** It
  contains NUL bytes, so use Python/Read, not `grep`, to inspect it.

### Measured facts (verified at commit `61b1e6e`)

- `index.html.count("═══")` = **32** (test asserts 28 → FAIL).
- Region names, each appearing once as `REGION: <NAME>` and once as
  `END: <NAME>`: `AUTH, OVERVIEW, DAILY, NETDNS, INFRA, SECURITY, ASKGLOBAL,
  PROVISION` = **8 regions**. `REGION:` count == `END:` count == 8, and the
  set of REGION names equals the set of END names.
- The tab array is exactly:
  `const TABS=['overview','daily','network','dns','infra','security','audit','provision','drift','selfservice']`
  = **10 tabs** (test asserts a frozen 7 → FAIL).

### The two failing methods as they exist today

`test_regression.py:498-504` (tab ids):

```python
    def test_seven_tab_ids(self):
        # AI is now a drawer (not a tab): 7 tabs, no 'ask'.
        self.assertContains(
            "const TABS=['overview','daily','network','dns','infra','security','audit']",
            "7-tab TABS array missing or reordered (daily must sit after overview)")
        for t in ("overview", "daily", "network", "dns", "infra", "security", "audit"):
            self.assertContains(t + ":", f"tab id '{t}' missing from TAB_LABELS/TAB_COMPONENTS")
```

`test_regression.py:600-604` (region markers):

```python
    def test_region_markers(self):
        # 7 regions × (REGION + END) × 2 markers-per-line = 28 occurrences
        # (v2 added the DAILY region)
        self.assertEqual(self.html.count("═══"), 28,
                         "expected exactly 28 '═══' region markers")
```

### Repo conventions to match

- Tests are `unittest`, class `FrontendStructureTests`, one assertion helper
  `self.assertContains(needle, msg)` (defined at `test_regression.py:451`).
- `import re` is already at the top (`test_regression.py:10`) — reuse it, do
  not re-import.
- An existing exemplar already extracts a region substring by name — reuse its
  approach for parsing rather than inventing a new one:
  `test_regression.py:685-688`
  ```python
      def _region(self, name):
          s = self.html.index("REGION: " + name)
          e = self.html.index("END: " + name, s)
          return self.html[s:e]
  ```
- Existing "count exactly once" invariants use `self.assertEqual(self.html.count(...), N)`
  (e.g. `test_synth_band` at line 581) — match that call style where you keep a count.
- Failure messages are terse, lower-case, and name the missing thing. Match that voice.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Drift check | `git diff --stat 61b1e6e..HEAD -- test_regression.py index.html` | no output (clean) |
| Run the two target tests | `python3 -m unittest test_regression.FrontendStructureTests.test_region_markers test_regression.FrontendStructureTests.test_seven_tab_ids -v` | `OK` |
| Run the whole frontend class | `python3 -m unittest test_regression.FrontendStructureTests -v` | `OK` (all frontend tests pass) |
| Confirm scope | `git status --porcelain` | only `test_regression.py` modified |

Note: `python3 -m unittest test_regression` (whole module, no class filter)
will still error on `BackendTests` unless a live server + tenant is running —
that is expected and is addressed only by the OPTIONAL step below.

## Scope

**In scope** (the only file you may modify):
- `test_regression.py` — rewrite `test_seven_tab_ids` and `test_region_markers`
  (Steps 1–2); optionally add one decorator to `BackendTests` (Step 3,
  OPTIONAL).

**Out of scope** (do NOT touch):
- `index.html` — do NOT edit it to make a test pass. The tests are wrong, not
  the HTML. Changing the app to satisfy a stale test is the exact failure mode
  this plan exists to remove.
- Any other test method in `test_regression.py`. Leave all passing tests alone.
- `server.py`, any file outside `test_regression.py`.

## Git workflow

- Branch: `advisor/013-fix-red-test-baseline` (create it; do not work on `master`).
- Commit style: conventional commits, matching repo `git log`
  (e.g. `test(regression): make tab + region assertions structural invariants`).
- One commit for Steps 1–2. If you do the OPTIONAL Step 3, a separate commit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make `test_seven_tab_ids` assert an ordered-subset invariant

Replace the method body at `test_regression.py:498-504`. Parse the actual
`TABS` array out of the HTML with a regex, then assert the required core tabs
appear **in order** as a subsequence — so new tabs (`provision`, `drift`,
`selfservice`, or any future tab) auto-enroll without breaking the test. Assert
on the parsed list, never on `self.html`, so a mismatch prints a short list
instead of the ~340 KB source.

Target shape (rename the method to reflect it is no longer "seven"; keep it
inside `FrontendStructureTests`):

```python
    def test_core_tab_ids_in_order(self):
        # Structural invariant, not a frozen snapshot: the TABS array must
        # CONTAIN the required core tabs in this order. New tabs (provision,
        # drift, …) may be appended/interleaved and auto-enroll. AI stays a
        # drawer, so 'ask' must never be a tab.
        REQUIRED = ["overview", "daily", "network", "dns", "infra", "security", "audit"]
        m = re.search(r"const TABS=\[([^\]]*)\]", self.html)
        self.assertIsNotNone(m, "const TABS=[...] array not found in index.html")
        tabs = re.findall(r"'([a-z]+)'", m.group(1))
        # every required tab present…
        missing = [t for t in REQUIRED if t not in tabs]
        self.assertEqual(missing, [], f"required tabs missing from TABS: {missing} (got {tabs})")
        # …and in the required relative order (subsequence check)
        pos = [tabs.index(t) for t in REQUIRED]
        self.assertEqual(pos, sorted(pos),
                         f"core tabs out of order in TABS: {tabs}")
        self.assertNotIn("ask", tabs, f"'ask' must not be a tab (AI is a drawer): {tabs}")
        for t in REQUIRED:
            self.assertContains(t + ":", f"tab id '{t}' missing from TAB_LABELS/TAB_COMPONENTS")
```

Notes for the executor:
- Keep the final `for t in REQUIRED: self.assertContains(t + ":", ...)` loop —
  it is an existing passing check (labels/components map) and must be preserved.
- Renaming the method is intentional (`seven` is now false). If your harness
  pins test names, you may instead keep the name `test_seven_tab_ids`; the body
  is what matters. Do not create a duplicate method.

**Verify**:
`python3 -m unittest test_regression.FrontendStructureTests.test_core_tab_ids_in_order -v`
→ `OK` (if you kept the old name, filter on that name instead) → `OK`.

### Step 2: Make `test_region_markers` assert balanced, named regions

Replace the method body at `test_regression.py:600-604`. Drop the hardcoded
`count("═══") == 28`. Instead assert the markers are structurally balanced:
every `REGION: <NAME>` has a matching `END: <NAME>` and vice-versa. Adding a
region then never breaks this test. Assert on the parsed name lists, not on
`self.html`.

Target shape:

```python
    def test_region_markers(self):
        # Structural invariant: every region is opened AND closed exactly once.
        # Adding a region (e.g. PROVISION) no longer breaks this test.
        opens = re.findall(r"REGION:\s*([A-Z0-9_]+)", self.html)
        closes = re.findall(r"END:\s*([A-Z0-9_]+)", self.html)
        self.assertGreater(len(opens), 0, "no REGION: markers found in index.html")
        self.assertEqual(sorted(opens), sorted(closes),
                         f"unbalanced region markers: opened={sorted(opens)} closed={sorted(closes)}")
        # no duplicate region names (each opened once)
        self.assertEqual(len(opens), len(set(opens)),
                         f"duplicate REGION: names: {opens}")
```

Notes for the executor:
- Do NOT reference the `═══` glyph count anywhere — that was the brittle bit.
- The regex `[A-Z0-9_]+` matches the observed uppercase region names
  (`AUTH, OVERVIEW, DAILY, NETDNS, INFRA, SECURITY, ASKGLOBAL, PROVISION`). If
  `re.findall` returns an empty `opens`, STOP (see STOP conditions) — the
  marker format has changed and this plan's assumption is void.

**Verify**:
`python3 -m unittest test_regression.FrontendStructureTests.test_region_markers -v`
→ `OK`.

### Step 3 (OPTIONAL — skip if it changes CI expectations): guard `BackendTests` behind `LIVE_INFRA`

`python3 -m unittest test_regression` (whole module) errors on all of
`BackendTests` unless a live server + tenant is running, so the offline static
run is not deterministically green. Guarding the class behind an env flag makes
the offline run green by default while preserving the live run.

`import os` is already present (`test_regression.py:10`). Add a class decorator
at `test_regression.py:67`:

```python
@unittest.skipUnless(os.getenv("LIVE_INFRA"),
                     "BackendTests need a live server+tenant; set LIVE_INFRA=1 to run")
class BackendTests(unittest.TestCase):
```

Do NOT change the `if __name__ == "__main__":` block (lines 736-754); it
already skips backend tests when the server is down for the
`python3 test_regression.py` entrypoint. The decorator only affects the
`python3 -m unittest test_regression` entrypoint.

**Skip this step if** the project's CI runs `python3 -m unittest test_regression`
against a live server and *expects* `BackendTests` to execute by default —
adding the guard would silently stop running them there. If unsure, STOP and
report rather than guess.

**Verify (only if you did this step)**:
`python3 -m unittest test_regression -v 2>&1 | tail -3` → `OK (skipped=<n>)`
with no errors, when no server is running.

## Test plan

- No new test *files*; two existing methods are rewritten in place and one
  optional decorator added — all in `test_regression.py`.
- Cases covered by the rewrites:
  - Tabs: required core present (happy path), out-of-order core (fails),
    `ask` present (fails), extra tabs like `provision`/`drift`/`selfservice`
    tolerated (the regression this plan fixes).
  - Regions: balanced open/close (happy path), an added region like
    `PROVISION` tolerated (the regression this plan fixes), unbalanced or
    duplicate markers (fails).
- Structural pattern to model after: the existing `_region` helper
  (`test_regression.py:685-688`) for name-based parsing, and `test_synth_band`
  (line 581) for the `assertEqual(self.html.count(...), N)` count style.
- Final verification:
  `python3 -m unittest test_regression.FrontendStructureTests -v` → `OK`, whole
  frontend class green including the two rewritten methods.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `python3 -m unittest test_regression.FrontendStructureTests -v` → `OK` (exit 0).
- [ ] `python3 -m unittest test_regression.FrontendStructureTests.test_region_markers -v` → `OK`.
- [ ] The tab test (renamed or original name) passes:
      `python3 -m unittest test_regression.FrontendStructureTests -v 2>&1 | grep -c ' ... ok'` ≥ prior count.
- [ ] No `28`, `count("═══")`, or a hardcoded 7-element `const TABS=[...]`
      literal remains as an assertion:
      `grep -nE "count\(.═══.\)|const TABS=\['overview','daily','network','dns','infra','security','audit'\]" test_regression.py`
      → no matches.
- [ ] `git status --porcelain` shows only `test_regression.py` modified;
      `index.html` is untouched.
- [ ] `plans/README.md` status row for 013 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `test_regression.py` or `index.html` changed since
  commit `61b1e6e`, and the "Current state" excerpts no longer match the live
  code.
- `re.search(r"const TABS=\[([^\]]*)\]", self.html)` returns `None`, or
  `re.findall(r"REGION:\s*([A-Z0-9_]+)", self.html)` returns an empty list —
  the tab-array or region-marker format described here is gone, and this plan's
  approach no longer applies.
- The set of `REGION:` names does NOT equal the set of `END:` names in the
  current `index.html` (run the drift-check Python from "Measured facts") —
  that means `index.html` itself has an unbalanced region, which is a real
  source bug, out of this plan's scope. Report it; do not "fix" it by loosening
  the test.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require editing `index.html` or any file other than
  `test_regression.py`.

## Maintenance notes

For the human/agent who owns this suite after the change lands:

- These two tests are now **additive-safe**: adding a UI region or a tab will
  not break them. That is the intent — do not "tighten" them back into frozen
  snapshots. If you need to assert a *specific* new tab exists, add a separate
  focused test rather than re-freezing `TABS`.
- The ordered-subsequence check still enforces the core tab order
  (overview→daily→network→dns→infra→security→audit). If the product
  deliberately reorders a core tab, update `REQUIRED` in
  `test_core_tab_ids_in_order` to match — that is a real product decision, not
  a flaky test.
- Reviewer should scrutinize: (1) that no assertion still references the raw
  `self.html` for these two checks (so failures stay short), and (2) that Step 3
  (if applied) did not silently disable `BackendTests` in an environment where
  CI expects them to run.
- Deferred out of this plan: `BackendTests`' 19 errors are only *masked* (via
  the optional skip), not fixed — they still need a live server + seeded tenant
  to actually run. Standing up that fixture is a separate, larger effort and is
  intentionally not in scope here.
