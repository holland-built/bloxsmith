# Drag-Drop Fix — Grill-me transcript (2026-06-15)

## Decisions
- Fix off-by-one in onDrop (primary bug — cards land 1 slot too far when dragging forward)
- Add custom drag ghost image (small labeled card, replaces browser's giant snapshot)
- Raise .dragging opacity from .35 → .5 (less disorienting)
- NO smooth reorder animation (FLIP too complex for single-file SPA, not worth the risk)
- NO touch drag support (out of scope)

## Open flags
- None — all branches resolved

## Q&A log
Q1: Main pain point? A: Cards land at wrong position (off-by-one confirmed by code audit)
Q2: Other fixes? A: /ui-ux consulted → ghost + opacity tweak in same pass
