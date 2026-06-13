# Context Hygiene

## Token Budget Awareness

Global skills + hooks burn ~30–40k tokens before the first message.
Per-project skill installs cost nothing when not in use — prefer them over global.

## Habits

- `/context` every ~20 minutes on long sessions.
- At 60% full → `/compact focus on <module>` to trim history.
- `/statusline` to monitor context %, 5h limit %, 7d limit %.

## When context is fragile

- Prefer `Explore` subagent over inline file reads when output is large.
- Delegate research to subagents — they return digests, not raw output.
- `index.html` is 4000+ lines — read only the section you need (pass `offset` + `limit`).
- Screenshot verification is expensive context — use only for visual confirmation, not routine checks.

## Long-running work

- `/branch` to fork the conversation when trying an experimental direction.
- `/teleport` to move cloud → local session.
- `/loop <interval> <cmd>` for repeated checks.

## Cache discipline

Anthropic prompt cache TTL = 5 min. Sleeping past 300s loses cache.
When polling: stay under 270s (cache warm) OR commit to 1200s+ (one cache miss, long wait).
Never 300s — it's the worst of both.

## This project's context profile

`index.html` is the largest single file. When doing multi-section edits, read only relevant
line ranges rather than the whole file. Use `Grep` to locate sections before reading.
`server.py` is secondary; read it only for backend/MCP tasks.
