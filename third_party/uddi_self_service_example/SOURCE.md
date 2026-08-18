---
upstream: https://github.com/ccmarris/uddi_self_service_example
ref: refs/heads/main
pinned_sha: 18e9f0acafe87813210aa14ca01879c6174263fe
pinned_date: 2026-08-14
vendored_date: 2026-08-18
license: BSD-2-Clause
copyright: Copyright (c) 2026 Chris Marrison / Infoblox
copyright_headers: Copyright (c) 2026 Chris Marrison / Infoblox
copyright_license_file: Copyright 2020 Chris Marrison / Infoblox
file_count: 25
---

# uddi_self_service_example — vendored source

Chris Marrison's Universal DDI self-service portal example, version 0.2.0, at the
pinned commit above. Not written by the Bloxsmith project. **Do not edit anything in
this directory** — it is an archive of someone else's work, and an edit here would make
the pin a lie.

## Why it is here

Bloxsmith's `ui/src/tabs/SelfService.jsx` and its Go endpoints derive their feature set
from this project: next-available-subnet allocation from a tagged address block,
provisioning a subnet with forward and reverse DNS zones in one action, zone and record
editing, and IP allocate/release. See [`NOTICE.md`](../../NOTICE.md) at the repo root
for the attribution and the upstream copyright notice.

It is kept as a copy rather than a submodule so the source survives the upstream
repository being deleted, renamed, or force-pushed. Nothing here is on any Bloxsmith
execution path: this is Python and Flask, Bloxsmith is a Go binary, and no build step
reads this directory.

## How it was imported

```
git archive 18e9f0acafe87813210aa14ca01879c6174263fe | tar -x -C third_party/uddi_self_service_example
```

`git archive` at the pinned commit, so the contents are exactly the files tracked
upstream at that commit — no local state, no `.git`, no caches. The directory is emptied
of everything except this `SOURCE.md` before extracting, rather than extracting over the
top: over-the-top leaves behind any file upstream has since deleted, which would make the
pin a lie in exactly the way this file exists to prevent. (Extraction was also asserted
against upstream shipping a `SOURCE.md` of its own, which would clobber this one.)

Verification is by content, not by filename. Every path in `git ls-tree -r 18e9f0a…` was
compared blob-hash-for-blob-hash against `git hash-object` of the extracted file, and its
mode bits checked: 25 files upstream, 25 vendored, all hashes and modes equal, no extra
paths beyond this `SOURCE.md`. A filename-only check passes a truncated file. Every
imported file was then scanned for credential-shaped content; `uddi.ini.example` holds
`your-api-key-here` and two commented-out lines, no secrets.

Licence headers here still differ in form from the sibling toolkit: 9 of the 11 `.py`
files carry the copyright line plus `SPDX-License-Identifier: BSD-2-Clause`, and none
carry the full clause text, where the toolkit's carry the clause text and no SPDX. Both
say the same thing; `NOTICE.md` records the difference rather than papering over it.

What this pin adds is a `LICENSE` file — it is the *only* change between `beb8548` and
here, and it is byte-identical to the one the toolkit gained in the same week. So the full
clause text is now present in this directory after all, just at the root rather than in
the headers. It also disagrees with those headers about the year (`Copyright 2020` against
the headers' `Copyright (c) 2026`), which is why the front matter above records both.

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
