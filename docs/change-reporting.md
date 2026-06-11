# Change Reporting

## Rule: summarize every change as a chart (markdown table)

After completing **each** change, end the response with a summary in **markdown table
format** — not prose. The table is the report of what happened.

Use columns that fit the change; a good default:

| Change | File(s) | Why | Status |
|--------|---------|-----|--------|

Guidance:
- One row per distinct change.
- `Status` reflects reality: `done`, `tested`, `deployed (vX.Y.Z)`, `committed (not pushed)`,
  `failed`, `skipped`. Never report `done` for something untested or unverified.
- Keep cells short. Code/commands go in fenced blocks outside the table if needed.
- For deploys, include the version badge number so it's verifiable in the running app.

## Why
Fast, scannable confirmation of exactly what moved, where, and whether it's live —
matching the operator-grade, density-first style of the product itself.
