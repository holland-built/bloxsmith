---
upstream: https://github.com/ccmarris/uddi_automation_toolkit
ref: refs/heads/main
pinned_sha: 820d0d6892b421b406afd1a5bdac6416e9ac9121
pinned_date: 2026-06-25
vendored_date: 2026-08-14
license: BSD-2-Clause
copyright: Copyright (c) 2026 Chris Marrison / Infoblox
file_count: 47
---

# uddi_automation_toolkit — vendored source

Chris Marrison's Universal DDI Site Toolkit, version 2.0.0, at the pinned commit above.
Not written by the Bloxsmith project. **Do not edit anything in this directory** — it is
an archive of someone else's work, and an edit here would make the pin a lie.

## Why it is here

Bloxsmith's `go/internal/provision/` is a derivative work of this toolkit, and
`go/templates/` follows its template schema and directory layout. See
[`NOTICE.md`](../../NOTICE.md) at the repo root for the attribution and the upstream
copyright notice.

It is kept as a copy rather than a submodule so the source survives the upstream
repository being deleted, renamed, or force-pushed. Nothing here is on any Bloxsmith
execution path: this is Python, Bloxsmith is a Go binary, and no build step reads this
directory.

## How it was imported

```
git archive 820d0d6892b421b406afd1a5bdac6416e9ac9121 | tar -x -C third_party/uddi_automation_toolkit
```

`git archive` at the pinned commit, so the contents are exactly the files tracked
upstream at that commit — no local state, no `.git`, no caches. The file list was then
compared against `git ls-tree -r --name-only 820d0d6…`: 47 files upstream, 47 vendored,
no missing and no extra. `uddi.ini.example` was read before import and contains
placeholders only, no credentials.

The `SOURCE.md` you are reading is the one file in this directory that is NOT from
upstream. Everything else is.

## Staying in sync

`.github/workflows/upstream-sync.yml` reads the `upstream`, `ref` and `pinned_sha`
fields above and checks weekly whether upstream has moved. Keep that front matter
machine-readable — the workflow fails closed if a field is missing or the SHA is not
40 hex characters.

Bumping the pin means re-running the import above with the new SHA and updating this
file. It is a deliberate act, not something the workflow does on its own: Bloxsmith is
a reimplementation and does not track this project commit for commit.
