# Daily Changelog

Append-only. Every code change gets an entry here before the task is marked done.
Format: markdown table under a `## YYYY-MM-DD — <title>` heading.

| File | Line(s) | Change |
|------|---------|--------|

---

## 2026-06-12 — Sprint: wizard, update bar, severity ribbon removal

| File | Line(s) | Change |
|------|---------|--------|
| `index.html` | ~2361-2406 | Add `DashboardWizard` component — two-tab first-run setup (Overview Widgets, Nav Sections), ▲▼ reorder, Visible/Hidden toggle, stored to `localStorage` |
| `index.html` | ~2951-2967 | Add `UpdateBar` component — fixed amber bar, phase labels (triggered/pulling/offline/reconnecting), elapsed timer, cancel button |
| `index.html` | ~3399-3424 | Rewrite `applyUpdate()` — state machine with `wasOffline` flag, no timeout, polls every 2s |
| `index.html` | various | Remove severity ribbon — deleted 6 CSS rules + JSX IIFE (redundant with per-row severity badges) |

## 2026-06-13 — Project scaffolding from Wayfinder best practices

| File | Line(s) | Change |
|------|---------|--------|
| `AGENTS.md` | new | Agent operating rules adapted for single-file React + Python stack |
| `DAILY_CHANGELOG.md` | new | Append-only change log (this file) |
| `.claude/skills/diagnose/SKILL.md` | new | 6-phase systematic bug diagnosis skill |
| `.claude/skills/grill-me/SKILL.md` | new | Pre-build planning interview skill |
| `.claude/skills/prove/SKILL.md` | new | Evidence-based completion verification skill |
| `.claude/skills/tdd/SKILL.md` | new | Vertical-slice TDD skill (adapted for pytest + headless Chrome) |
| `.claude/skills/layout-stress/SKILL.md` | new | Layout-composition robustness testing skill |
| `CLAUDE.md` | all | Added lazy-read table, log-every-change rule, verify rule, drift checks, skills reference |
