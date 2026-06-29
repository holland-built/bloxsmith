# Plan 003 — Drop SUGGESTIONS: text-format fallback from _parse_ai_response

**Written against commit:** a682fa7  
**Effort:** S  
**Risk:** Very low — fallback for a format the prompt never requests  
**Category:** YAGNI

---

## Why this matters

`_parse_ai_response` (server.py lines 1419–1456) has three parse strategies:

1. Direct JSON parse — nominal case.
2. Scan for embedded JSON object — handles prose wrapping (Qwen3 think blocks already stripped).
3. `SUGGESTIONS:` plain-text block — handles a format the prompt never requests.

The LLM prompt (`_AI_SYSTEM`, server.py:1200) says: "Your FINAL response must be ONLY this JSON … No other text before or after." The prompt never mentions a `SUGGESTIONS:` marker. Attempt 3 covers a format that requires the model to both ignore the JSON instruction AND emit a non-JSON sentinel this code invented. In practice it never fires.

Lines to remove: server.py 1449–1454 (6 lines, from `# Attempt 3` comment through the `return` it guards).

---

## Scope

**In scope:** `server.py`, function `_parse_ai_response`, lines 1449–1454.  
**Out of scope:** Attempts 1 and 2, the think-block stripping, the fence stripping, and the final `return {"answer": raw, "suggestions": []}` — all stay.

---

## Current code to remove (lines 1449–1454)

```python
    # Attempt 3: SUGGESTIONS: plain-text block
    if "SUGGESTIONS:" in raw:
        parts = raw.split("SUGGESTIONS:", 1)
        sugs = [l.strip().lstrip("-•*123456789. ") for l in parts[1].strip().splitlines() if l.strip()]
        return {"answer": parts[0].strip(), "suggestions": sugs[:5]}
```

The line immediately after (`return {"answer": raw, "suggestions": []}`) is the final fallback — it stays.

---

## Steps

1. Check escape hatch first:
   ```bash
   grep "SUGGESTIONS:" "/Users/sholland/AI/Infoblox MCP/test_regression.py"
   ```
   Expected: 0 hits. If any hits: STOP and report — a test covers this path.

2. Delete lines 1449–1454 in server.py (the `# Attempt 3` block through the `return` it guards).

3. Confirm the final fallback is intact — the last line of the function should be:
   ```python
       return {"answer": raw, "suggestions": []}
   ```

4. Verify:
   ```bash
   cd "/Users/sholland/AI/Infoblox MCP" && python3 -c "import server; print('ok')"
   ```
   Expected: `ok`

   ```bash
   cd "/Users/sholland/AI/Infoblox MCP" && python3 -m pytest test_regression.py -x -q 2>&1 | tail -5
   ```
   Expected: same result as before.

---

## Done criteria

- `grep "SUGGESTIONS:" server.py` → 0 hits inside `_parse_ai_response`.
- `python3 -c "import server"` exits 0.
- Regression tests unchanged.

---

## Maintenance note

If `_AI_SYSTEM` is ever changed to request a non-JSON output format, revisit whether a plain-text fallback is needed again.
