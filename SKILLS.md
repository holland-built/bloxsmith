# SKILLS.md
# Skills available in this project.

## Installed (project)

| Skill | Purpose |
|---|---|
| `impeccable` | UI design enforcement — visual hierarchy, spacing, density, color discipline |
| `ui-ux-pro-max` | Design intelligence — 67 styles, 96 palettes, 57 font pairings, 99 UX guidelines, accessibility rules, chart types |
| `layout-stress` | Runtime layout-composition fixer — panel overlap, clipping, bleed, truncation, min-width starvation across viewport widths |
| `diagnose` | 6-phase systematic bug diagnosis — never trust the problem description |
| `grill-me` | Pre-build planning interview — extracts design decisions, edge cases, constraints before any code |
| `prove` | Evidence-based feature verification — screenshot + real server, no optimism |
| `tdd` | Vertical-slice test-driven development |

## Available (global — `~/.claude/`)

| Skill | Purpose |
|---|---|
| `forge` | Full pipeline: grill-me → Opus plan → approval gate → TDD → Sonnet build → prove |
| `caveman:caveman` | Ultra-compressed communication mode (~75% token cut) |
| `caveman:caveman-review` | Code review in caveman mode |
| `code-review` | Review current diff for correctness + simplification |
| `simplify` | Simplification pass on changed code |
| `verify` | Run app and observe behavior to confirm a change works |
| `run` | Launch and drive this project's app |
| `security-review` | Security audit of pending changes |
| `deep-research` | Multi-source, fact-checked research report |
| `graphify` | Any input → knowledge graph |

## When to invoke (daily drivers)

| Skill | Trigger |
|---|---|
| `/grill-me` | Before any non-trivial feature — extracts design decisions before code |
| `/diagnose` | Any unexpected behavior — never trust the symptom description |
| `/tdd` | Every bug fix or new server.py/test_regression.py behavior |
| `/prove` | Before claiming any feature "done" — screenshot + real server |
| `/layout-stress` | Any sidebar/panel/bento overlap report; after index.html layout changes |
| `/impeccable` | UI polish pass — density, hierarchy, color discipline, spacing |
| `/ui-ux-pro-max` | Design decisions — palette, typography, accessibility, chart type, UX guidelines |
| `/code-review` | Before committing a non-trivial change |
| `/security-review` | Any change touching .env, auth, API keys, or server.py endpoints |

## Invocation

```
/diagnose          # 6-phase bug diagnosis
/grill-me          # pre-build planning interview
/prove             # evidence-based verification
/tdd               # test-driven development
/layout-stress     # layout bug hunting
/impeccable        # UI design audit/polish
/ui-ux-pro-max     # design intelligence — palette, UX rules, accessibility
```

## learnings.md pattern

For any skill you customize, add a `learnings.md` next to its `SKILL.md`.
After each session where the skill needed correction, log the correction dated.
Example: `2026-06-13: /prove was skipping docker restart step — added explicit check.`
This is the only pattern that compounds with use.
