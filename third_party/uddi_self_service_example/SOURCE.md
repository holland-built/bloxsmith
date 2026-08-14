---
upstream: https://github.com/ccmarris/uddi_self_service_example
ref: refs/heads/main
pinned_sha: beb8548e3644008a7f3dd19569843e67551aa442
pinned_date: 2026-05-28
vendored_date: 2026-08-14
license: BSD-2-Clause
copyright: Copyright (c) 2026 Chris Marrison / Infoblox
file_count: 24
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
git archive beb8548e3644008a7f3dd19569843e67551aa442 | tar -x -C third_party/uddi_self_service_example
```

`git archive` at the pinned commit, so the contents are exactly the files tracked
upstream at that commit — no local state, no `.git`, no caches. The file list was then
compared against `git ls-tree -r --name-only beb8548…`: 24 files upstream, 24 vendored,
no missing and no extra. `uddi.ini.example` was read before import and contains
placeholders only, no credentials.

Licence headers here differ in form from the sibling toolkit: these files carry the
copyright line plus `SPDX-License-Identifier: BSD-2-Clause` rather than the full clause
text. Both say the same thing; `NOTICE.md` records the difference rather than papering
over it.

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
