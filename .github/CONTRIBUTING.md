# Contributing

Thanks for your interest in improving Bloxsmith. This is a small
demo/dashboard tool — contributions that keep it simple and dependency-light are
most welcome.

## Local development (without Docker)

Requires **Python >= 3.11** (tested on 3.13) and `pip`.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in your keys
python server.py            # → http://localhost:8080
```

Set `HOST=0.0.0.0` to expose beyond localhost. See the README for the full env-var
table and the Docker quick start.

> **Node/npx** is only required if you use the `.mcp.json` / `mcp-remote` path. The
> default `python server.py` bridge uses the `mcp` pip package and needs no Node.

## Running the tests

`tests/test_regression.py` is an HTTP-level regression suite that exercises a **running**
server.

```bash
# in one terminal
python server.py

# in another (with the venv active)
python tests/test_regression.py
# or, verbose:
python -m unittest test_regression -v
```

Add or update a test when you change an endpoint's shape or add a new one.

## Code style

- Keep it simple and surgical — match the existing style; no large refactors bundled
  with feature work.
- Python: standard library first; only add a dependency when it earns its place, and
  pin it in `requirements.txt`.
- Frontend (`index.html`) is a single-file React app — keep changes self-contained.

## Branch / PR process

1. Fork and branch off `main` (e.g. `fix/dns-zone-parsing`, `feat/widget-resize`).
2. Make focused commits; keep each PR scoped to one logical change.
3. Run the regression suite locally before opening the PR and note the result.
4. Open a PR with a clear description of what changed and why. Link any related issue.

## Security & secrets

- **Never commit `.env` or real API tokens.** `.env` is gitignored — use
  `.env.example` as the template.
- Do not commit local state (`*.db`, `*.log`, cache files).
- If you accidentally expose an Infoblox token, **rotate it in the CSP portal** —
  scrubbing it from git history does not revoke it. See [SECURITY.md](SECURITY.md).
