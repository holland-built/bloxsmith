# Testing Discipline

## TDD Default (Karpathy Rule 4)

For any bug fix or new feature:
1. Write a failing test that reproduces the bug or specifies the feature.
2. Run it — confirm it fails for the right reason.
3. Write minimum code to pass.
4. Refactor only if tests still pass.

Skill: `/tdd`

## Stack-Specific Commands

**Regression suite (Python/pytest):**
```bash
python -m pytest test_regression.py -v
```

**Single test:**
```bash
python -m pytest test_regression.py::test_name -v
```

**Backend smoke (server.py running locally):**
```bash
curl -s http://localhost:8080/api/notices | python3 -m json.tool | head -40
```

## UI Verification (mandatory for any index.html change)

**Before coding:** see `docs/design-workflow.md` — build a standalone `_mockup.html` first.

**After production code (hotpatch + verify):**
```bash
# 1. Patch container
docker cp index.html infoblox-noc:/app/index.html && docker restart infoblox-noc

# 2. Screenshot (headless — renders light theme; verify dark by construction)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --window-size=1440,900 \
  --screenshot=_proof.png "http://localhost:8080"

# 3. Open live
open http://localhost:8080
```

**Never claim "done" on a UI change without a real screenshot or open-browser observation.**

Skill: `/prove`

## Drift checks (before claiming done on any UI change)

- Severity glanceable? Red/amber/green readable from across a room?
- Dense enough? Operators want rows, not cards.
- No hardcoded hex colors in JSX/inline styles — all via CSS tokens.
- Dark theme intact? Headless defaults to light — verify dark by construction.
- No layout regression? Sidebar + bento grid + chat at 1280px+.

## When to skip TDD

Trivial: typo fixes, single-line renames, comment edits, CSS token tweaks.
Everything else: TDD.
