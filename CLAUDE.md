# Infoblox NOC Dashboard — Project Instructions

## Read on demand (lazy — NOT auto-loaded)

| When | Read |
|---|---|
| Any task | `DESIGN.md` — color tokens, typography, component patterns |
| Product / UI / purpose | `PRODUCT.md` — user, purpose, brand, design principles |
| Multi-file / agent dispatch | `AGENTS.md` — agent behavior, team dispatch, hotpatch workflow |
| Deployment / Docker | `docs/DEPLOYMENT.md` — Docker, compose, env vars, Watchtower |
| Any design/GUI change | `docs/design-workflow.md` — mockup workflow (required before any UI change) |
| After each change | `docs/change-reporting.md` — required markdown table summary |
| Skills | `.claude/skills/` — diagnose, grill-me, prove, tdd, layout-stress |

Do NOT read files not required by the task.

## Log every change

After every code change, append an entry to `DAILY_CHANGELOG.md` **before** the task is marked done.
Format: markdown table with columns `File`, `Line(s)`, `Change`. Group under a `## YYYY-MM-DD — <title>` heading. No prose paragraphs — table only.

## Verify after every change

Every code change ends with evidence before "done":
- Hotpatch container: `docker cp index.html infoblox-noc:/app/index.html && docker restart infoblox-noc`
- Screenshot: headless Chrome `--screenshot=_proof.png "http://localhost:8080"`
- Or run tests: `python -m pytest test_regression.py -v`
- If verify is skipped, the task is NOT complete.

## Independent diagnosis rule

Never take user problem descriptions as ground truth. Read code, trace the actual path, surface causes the user didn't name. Use `/diagnose` for systematic debugging.

## Skills (user-invocable)

- `/diagnose` — 6-phase systematic bug diagnosis
- `/grill-me` — pre-build planning interview
- `/prove` — evidence-based feature verification
- `/tdd` — vertical-slice test-driven development
- `/layout-stress` — layout-composition bug hunting at multiple widths
