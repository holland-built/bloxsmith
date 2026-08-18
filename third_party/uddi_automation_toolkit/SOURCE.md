---
upstream: https://github.com/ccmarris/uddi_automation_toolkit
ref: refs/heads/main
pinned_sha: 0679cef22583e1c0dd3699401c728bac943c4852
pinned_date: 2026-08-14
vendored_date: 2026-08-18
license: BSD-2-Clause
copyright: Copyright (c) 2026 Chris Marrison / Infoblox
copyright_headers: Copyright (c) 2026 Chris Marrison / Infoblox
copyright_license_file: Copyright 2020 Chris Marrison / Infoblox
file_count: 48
---

# uddi_automation_toolkit — vendored source

Chris Marrison's Universal DDI Site Toolkit, version 2.0.0, at the pinned commit above.
Not written by the Bloxsmith project. **Do not edit anything in this directory** — it is
an archive of someone else's work, and an edit here would make the pin a lie.

This pin ships a `LICENSE` file; the previous one (`820d0d6`, 2026-06-25) did not, and
`NOTICE.md` had to transcribe the licence text out of the per-file headers instead. That
`LICENSE` is now the authoritative copy in this repository. Note the two disagree about the
year — the headers say `Copyright (c) 2026`, the `LICENSE` says `Copyright 2020` — which is
why the front matter above records both rather than picking one. Nothing here can settle
which Chris means, and `NOTICE.md` reproduces both.

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
git archive 0679cef22583e1c0dd3699401c728bac943c4852 | tar -x -C third_party/uddi_automation_toolkit
```

`git archive` at the pinned commit, so the contents are exactly the files tracked
upstream at that commit — no local state, no `.git`, no caches. The directory is emptied
of everything except this `SOURCE.md` before extracting, rather than extracting over the
top: over-the-top leaves behind any file upstream has since deleted, which would make the
pin a lie in exactly the way this file exists to prevent. (Extraction was also asserted
against upstream shipping a `SOURCE.md` of its own, which would clobber this one.)

Verification is by content, not by filename. Every path in `git ls-tree -r 0679cef…` was
compared blob-hash-for-blob-hash against `git hash-object` of the extracted file, and its
mode bits checked: 48 files upstream, 48 vendored, all hashes and modes equal, no extra
paths beyond this `SOURCE.md`. A filename-only check passes a truncated file. Every
imported file was then scanned for credential-shaped content; `uddi.ini.example` holds
`<your-api-key-here>` and Chris's own lab names, no secrets.

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
