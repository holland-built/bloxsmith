---
name: forge
description: Full feature-build pipeline orchestrator — grill-me → Opus plan → approval gate → UI mockup gate → TDD → Sonnet build → regression gate → prove. Runs the whole sequence end to end with hard gates. Activate on "/forge", "forge", "build this feature end to end".
user-invocable: true
argument-hint: "[describe the feature to build]"
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
---

Feature: $ARGUMENTS

Run all phases IN ORDER. Every gate is hard — do not skip ahead.

**Agent rule:** Never write code inline. All planning → Opus agent. All implementation → Sonnet agent(s). Independent steps always fan out concurrently. Coordinator reads + dispatches only.

**Uncertainty rule:** At any phase, if intent is unclear or a decision wasn't covered in grill-me — stop. Ask the question. Do not guess, assume, or proceed. Treat unanswered questions the same as a failed gate.

Project: Infoblox NOC Dashboard. Python backend `server.py`, single-file React SPA `index.html`, tests `test_regression.py`, container `infoblox-noc`.

`<slug>` = kebab of feature. `<date>` = today.

## 1 — Grill-me (BEFORE any planning)
Never plan from the raw description. Interview one question at a time, recommend an answer each time, walk every branch. Checkpoint each answer to `brainstorms/<slug>-<date>.md` (Decisions / Open flags / Q&A log). Stop when all branches resolved or user says "done".

## 2 — Opus plan
Spawn ONE `Agent` (model: opus) with the full grill-me transcript as context. It must produce:
- target file list
- ordered implementation steps
- per target file: an "already exists — do NOT recreate" note
- ~300-word cap per downstream subagent
- flag: `ui_change: true/false` (true if any change touches `index.html` or visible UI)
Save to `brainstorms/<slug>-plan-<date>.md`.

## 3 — Approval gate (HARD)
Show the plan. Then stop and ask exactly: **"Approve this plan or redirect?"**
Do NOT write code until the user says yes/go/approved. If they redirect, loop back to phase 1 or 2.

## 3.5 — UI mockup gate (ONLY if ui_change: true)
Skip entirely for backend-only changes.

1. Build 5–8 mockup variants as individual files `mockups/<slug>/<slug>-v1.html` … `v8.html` using real design tokens copied from `index.html` `:root` variables.

2. Build ONE combined page `mockups/<slug>/<slug>-all.html` that shows ALL variants side-by-side in a single scrollable page. Each variant gets a labeled section (v1, v2 …) with its description. Mark the recommended variant with a visible **"★ Recommended"** badge in the label. Use the same design tokens. This is what the user will review.

3. **MANDATORY — do both, neither is skippable:**
   - `open "mockups/<slug>/<slug>-all.html"` — opens combined page live in browser so user can see hover states and animations
   - `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --window-size=1400,900 --screenshot=mockups/<slug>/<slug>-all.png "file://$PWD/mockups/<slug>/<slug>-all.html"` — screenshot of combined page for inline display

4. Show the combined screenshot inline. Then output the variant table:

| Variant | Description | Pick |
|---|---|---|
| v1 | one-line description | |
| vN | one-line description | ★ recommended |

5. Stop and ask: **"Which mockup variant? (or redirect)"**
Do NOT proceed until user names a variant. Lock the chosen variant — Sonnet builds to match it exactly.
Mockup files stay in `mockups/<slug>/` until after phase 6; delete only after prove passes.

## 4 — TDD
Per behavior: write ONE failing test in `test_regression.py` → run `python -m pytest test_regression.py -v` → confirm RED → minimum code to pass → confirm GREEN → repeat. No batching all tests first.

## 5 — Sonnet build

**Cap: max 5 agents at once.** If plan has >5 independent steps, batch into rounds of 5; wait for each round before starting the next (sequential deps must respect ordering).

**Before dispatching ANY agent** — write a per-agent spec covering:
- Target file (absolute path)
- Exact change to make (quote plan step + grill-me context)
- Functions/components adjacent to the edit that must NOT be touched
- `Already exists — do NOT recreate: <file>` note
- If ui_change: which mockup variant section/element to match exactly

Fan out all agents in one parallel call (never one-at-a-time). Every agent MUST:
- read its target file + direct imports before editing
- include the explicit **"already exists — do NOT recreate: <file>"** section in its prompt
- cap output ~300 words
- if ui_change: match the approved mockup variant exactly

Hotpatch after `index.html` edits: `docker cp index.html infoblox-mcp:/app/index.html && docker restart infoblox-mcp`

## 5.5 — Regression gate + fix loop (HARD)
After ALL Sonnet agents complete, run the full suite:
```
python -m pytest test_regression.py -v
```
If ANY test fails → enter fix loop. Repeat until green:

1. Spawn `Agent` (model: opus) with: failing test output + full diff of changes so far. It produces a fix plan targeting only the broken behavior. Save to `brainstorms/<slug>-fix-<N>-<date>.md`.
2. Spawn `Agent` (model: sonnet) per fix step (fan out independent steps). Every dispatch MUST read target file before editing + include "already exists — do NOT recreate" note.
3. Hotpatch if `index.html` touched.
4. Re-run `python -m pytest test_regression.py -v`.
5. If still failing → increment N, loop back to step 1. Cap at 3 iterations. If still red after 3 → stop and surface to user: "3 fix attempts failed. Paste output to continue."

Do NOT proceed to phase 6 with a red suite.

## 6 — Prove (mandatory before done)
Run: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --window-size=1400,900 --screenshot=_proof.png "http://localhost:8080"` and show `_proof.png`.
Then append to `DAILY_CHANGELOG.md` under `## <date> — <feature>` a table: `File | Line(s) | Change`.

Task is NOT done until: screenshot shown + changelog appended + test suite green.

## 7 — Summary
Print a markdown table summarizing everything completed this forge run:

| Phase | What happened | Files changed | Tests |
|---|---|---|---|
| Grill-me | Key decisions made | `brainstorms/<slug>-<date>.md` | — |
| Opus plan | N steps planned | `brainstorms/<slug>-plan-<date>.md` | — |
| UI mockups | Variant vN approved / skipped | `mockups/<slug>/` or n/a | — |
| TDD | N behaviors, N tests written | `test_regression.py` | N green |
| Sonnet build | N agents, N files edited | list each file | — |
| Fix loop | N iterations / not needed | list files if any | — |
| Prove | Screenshot taken | `_proof.png`, `DAILY_CHANGELOG.md` | all green |
