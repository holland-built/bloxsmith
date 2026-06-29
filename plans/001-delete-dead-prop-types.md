# Plan 001 — Delete dead prop-types.min.js

**Written against commit:** a682fa7  
**Effort:** S  
**Risk:** Minimal — file is never loaded  
**Category:** Delete (dead code)

---

## Why this matters

`prop-types.min.js` (1.7 KB) sits in the project root alongside `react.min.js`, `react-dom.min.js`, and `babel.min.js`. The other three are loaded via `<script src="...">` tags in `index.html` (lines 26–28). `prop-types.min.js` is never referenced anywhere in `index.html` or `server.py`. It is a dead artifact.

Evidence:
- `grep prop-types index.html` → 0 hits
- `grep prop-types server.py` → 0 hits
- File on disk: `/prop-types.min.js`, 1.7 KB, dated May 18

---

## Scope

**In scope:** Delete `/prop-types.min.js`.  
**Out of scope:** Do not touch `react.min.js`, `react-dom.min.js`, or `babel.min.js` — those are actively loaded.

---

## Steps

1. Confirm 0 references in codebase:
   ```bash
   grep -r "prop-types" /Users/sholland/AI/Infoblox\ MCP/ --include="*.html" --include="*.py" --include="*.js"
   ```
   Expected: no output. If any output: STOP and report back — do not delete.

2. Delete the file:
   ```bash
   rm "/Users/sholland/AI/Infoblox MCP/prop-types.min.js"
   ```

3. Verify server still imports cleanly:
   ```bash
   cd "/Users/sholland/AI/Infoblox MCP" && python3 -c "import server" && echo "import ok"
   ```
   Expected: `import ok`

---

## Done criteria

- `prop-types.min.js` does not exist in the repo root.
- `grep -r prop-types .` returns 0 hits.
- `python3 -c "import server"` exits 0.

---

## Maintenance note

If someone adds PropTypes usage to `index.html` in the future, they should add `prop-types.min.js` back. The correct source is the npm package — copy the minified build from `node_modules/prop-types/prop-types.min.js` after `npm install prop-types`.
