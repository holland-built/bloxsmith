# Plan

**Goal:** after the first Infoblox key is added, a short "Finish setup" checklist helps set up
the rest: AI answers, the demo server, logo and name, and templates.

## What the user decided (2026-11-05)

- Show it once, right after the first key is added, and reopen it any time from Settings.
- Docker installs see the Demo server step, with a line saying it needs the desktop app.
- Templates: show which are installed, or how to get them. No upload.
- AI: provider buttons (Groq, Gemini, OpenAI, Ollama) that fill in the address and model.

Approach: Codex and an Opus helper proposed the same thing separately, so no tiebreak.
The dashboard opens straight away with the checklist over it. Each item has
"Do this later", and Finish closes it with items left. The AI, demo and branding forms are
shared with their current homes, not copied. The Groq box on the first-key screen goes,
because the AI step replaces it.

## Done when

1. A new install goes passphrase, key, dashboard, with the checklist on top, and nothing more
   is required before the dashboard.
2. Every item can be skipped, and Finish closes the checklist with items left.
3. Settings > Setup reopens it, showing what is already set.
4. In Docker, the Demo server item says it needs the desktop app.
5. Picking a provider fills in its address and model; Test and Save work as they do in Settings.
6. Tests cover 1 to 5, and the existing Settings, Demo server and logo tests still pass.

## What happened

- All six "done when" points have a browser test in `tests/setup-checklist.spec.ts` (8 tests).
- Changed from the plan: the checklist opens on a signal from the first-key screen, not a
  stored flag, because the app reads storage before the first key exists.
- Found while building: the first-key screen's Groq box sent `groqKey`, which the server never
  read, so a Groq key typed there was never saved. The box is gone; the AI step replaces it.
- Codex review: two rounds. Fixed: the AI item updates after Save; Docker and loading states
  wait for the server's answer.
