# Planning Guide

## When to plan vs just code

**Just code:** single-file change, well-understood scope, < 30 min estimated work.
**Plan first:** new feature, multi-file change, architectural decision, or any task where
getting it wrong means significant rework.

## Planning flow

```
grill-me → Opus planner → Sonnet subagent execution
```

1. **/grill-me** — pre-build interview. Extracts design decisions, edge cases, constraints,
   open questions. One question at a time. Do not skip this — it prevents 80% of mid-build pivots.

2. **Opus planner** — after grill-me, dispatch an Opus agent to produce the plan:
   ```
   Agent(subagent_type="Plan", model="opus", prompt="<problem + grill-me answers>")
   ```
   Plan output: phase order, critical risks, key files, gotchas, env vars needed.

3. **Sonnet execution** — dispatch Sonnet subagents per plan phase. Never plan inline.

## Plan file location

Save active plans to `~/.claude-work/plans/<slug>.md`. Reference them in the task.
When done, update the plan status (completed / abandoned) — do not delete.

## Feature planning template

```markdown
## Goal
One sentence: what the feature does for the operator.

## Trigger
What user action or data event starts this.

## Scope
- In: what this feature covers
- Out: what it explicitly does NOT cover

## Key files
- index.html: which sections / components change
- server.py: which endpoints change (if any)
- test_regression.py: new tests needed

## Phases
1. Backend (server.py changes + tests)
2. Frontend mockup (design-workflow.md)
3. Frontend implementation
4. Verify (hotpatch + screenshot + tests)

## Risks / gotchas
```

## Stack constraints to call out in every plan

- `index.html` is a single file — no imports, no components split across files.
  Scope must account for this: large changes need careful section targeting.
- No build step — JSX transpiled in-browser by Babel. No TypeScript, no tree-shaking.
- Docker hotpatch is the deploy path — no CI gate between edit and observation.
- All color via CSS tokens. Any plan touching UI must reference `COLOR_CONTRACT.md`.
