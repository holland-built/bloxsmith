# AGENTS.md — Infoblox NOC Dashboard

Single source of truth for any agent working in this repo.

## What this is

A local, single-page NOC dashboard for Infoblox Portal/CSP. A Python bridge (`server.py`) speaks MCP to `csp.infoblox.com`, normalizes data, and serves a React dashboard (`index.html`). Single-file React app — Babel-transpiled JSX, no build step.

## Read first (lazy — NOT auto-loaded)

| When | Read |
|---|---|
| Any task | `DESIGN.md` — color tokens, typography, component patterns |
| Product / UI / purpose | `PRODUCT.md` — user, purpose, brand, design principles |
| Deployment / Docker | `docs/DEPLOYMENT.md` — Docker, compose, env vars, Watchtower |
| Design/GUI change | `docs/design-workflow.md` — mockup workflow (required before any UI change) |
| Skills | `.claude/skills/` — diagnose, grill-me, prove, tdd, layout-stress |

Do NOT read files not required by the task.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Single-file React app (`index.html`), Babel-transpiled JSX in-browser, inline CSS |
| Backend | Python + FastAPI (`server.py`), MCP client to Infoblox CSP API |
| Deployment | Docker (`Dockerfile`), compose (`docker-compose.yml`), Watchtower for auto-update |
| Tests | `test_regression.py` (pytest) |
| AI / NL query | Optional: Groq or OpenAI via `GROQ_API_KEY` / `OPENAI_API_KEY` |

## Key files

| File | Role |
|---|---|
| `index.html` | Entire frontend — React components, inline CSS, all UI logic |
| `server.py` | Python API — MCP bridge, data normalization, vault, update polling |
| `docker-compose.yml` | Production compose stack with Watchtower |
| `test_regression.py` | Regression test suite (pytest) |
| `.env` / `.env.example` | Secrets and config |

## Workflow rules

- **Plan first.** Multi-step or architectural work: plan internally before editing. No yes/no confirmation questions.
- **Surgical changes.** Every changed line traces to the request. No "while I'm here" edits.
- **Simplicity first.** Single-file React app — prefer 50 lines over 200. No enterprise patterns.
- **Verify before claiming done.** Hotpatch container, open browser, observe with eyes — NOT just type-checks.
- **Mockup first for UI changes.** Per `docs/design-workflow.md`: build a standalone `_mockup.html` with real CSS tokens, screenshot headless, then open in browser.
- **Log every change.** Append to `DAILY_CHANGELOG.md` before marking done.
- **Sub-agents.** Dispatch parallel agents for independent work. Read target file before dispatching any file-editing agent.

## Hotpatch (fast test without Docker rebuild)

```bash
docker cp index.html infoblox-noc:/app/index.html && docker restart infoblox-noc
sleep 4 && open http://localhost:8080
```

## Run tests

```bash
python -m pytest test_regression.py -v
```

## Independent diagnosis rule

**Never take user problem descriptions as ground truth.** Read the code, trace the actual path, surface causes the user didn't name. Use `/diagnose` for systematic debugging.

## Drift checks

Before claiming done on any UI change:
- Glanceable severity? Red/amber/green readable from across a room?
- Dense enough? Operators want rows, not cards.
- No hardcoded colors? All color via CSS tokens.
- Dark theme intact? Headless Chrome defaults to light — verify dark by construction.
- No layout regression? Sidebar + bento grid + chat panel at 1280px+.
- Evidence observed? Screenshot or curl output — not "should work".

## Model split (Opus plans, Sonnet codes)

Always split by phase:

```
Agent(subagent_type="Plan", model="opus", prompt="Design approach for X...")  → plan
Agent(model="sonnet", prompt="Implement: <plan step>")                        → code
```

**Auto-fire Opus planner when:** user says "plan X", task is multi-file, or getting it wrong
means significant rework. Never plan inline — delegate planning to an Opus agent.

## When to delegate to subagents

- **Independent searches** across 2+ areas → parallel `Explore` agents (max 3)
- **Large tool output** (full index.html read, long curl response) → subagent returns digest
- **Multi-perspective design** → 2–3 `Plan` agents in parallel (model: "opus")
- **Approved plan execution** → Sonnet subagents per phase

## When NOT to delegate

- Single known file edit → use Read/Edit directly
- Trivial question → answer from working context
- Already have full context for the task

## Agent teams

| Team | Use for |
|---|---|
| **UI build** | React components, CSS, index.html edits — read index.html first |
| **Backend** | server.py API routes, MCP bridge, Python logic |
| **Debug** | `/diagnose` skill for bugs; `/prove` to verify completeness |
| **Test** | `/tdd` for new behavior; `test_regression.py` for regressions |
| **Layout** | `/layout-stress` for overflow/overlap bugs at multiple widths |

## Do not drift into

- Neon "cyber" SOC aesthetic (glowing globes, matrix-green gradients, animated radar).
- SaaS marketing gloss (hero metrics, oversized whitespace, onboarding confetti).
- Decorative animation that doesn't encode state.
- Hardcoded hex colors in JSX or inline styles (always use CSS tokens).
