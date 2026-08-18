# NOTICE

Bloxsmith is released under the [MIT License](LICENSE). This file records third-party
work Bloxsmith is derived from, and reproduces the copyright notices that work carries.

---

## Chris Marrison — Infoblox Universal DDI tooling

Bloxsmith's provisioning engine and self-service surface are derived from two public
projects by **Chris Marrison** (<chris@infoblox.com>), both licensed BSD-2-Clause:

| Project | Version | Commit this notice was written against |
|---|---|---|
| [ccmarris/uddi_automation_toolkit](https://github.com/ccmarris/uddi_automation_toolkit) | 2.0.0 | `0679cef`, 2026-08-14 |
| [ccmarris/uddi_self_service_example](https://github.com/ccmarris/uddi_self_service_example) | 0.2.0 | `18e9f0a`, 2026-08-14 |

Both are vendored under [`third_party/`](third_party/) at the pinned commits above, with
their per-file copyright headers and their `LICENSE` files intact.
`third_party/<project>/SOURCE.md` records the exact upstream ref and commit for each, and
how the import was verified.

### What Bloxsmith derives from each

**From `uddi_automation_toolkit`** — the tag-driven provisioning model that
`go/internal/provision/` implements: site, address-block and DNS resources across
provision, decommission, query and drift; the YAML template schema; and the
`region/environment` template tree under `go/templates/`.

The derivation is direct, and Bloxsmith's own source has said so since the Go port.
From `go/internal/provision/helpers.go`:

> a faithful, function-by-function port of the ~1,400-line orchestration block in
> server.py (1006-2395), itself a port of Chris Marrison's UDDI Automation Toolkit.
> Every ordered create/rollback step and every fail-forward teardown ordering is
> preserved verbatim; Python is the reference and its quirks are matched, not
> "improved".

**From `uddi_self_service_example`** — the self-service surface behind
`ui/src/tabs/SelfService.jsx` and its Go endpoints: next-available-subnet allocation
from a tagged address block, provisioning a subnet with forward and reverse DNS zones
in one action, authoritative zone and resource-record editing, and IP allocate/release.

### How the code relates

No file in Bloxsmith is a textual copy of either project. The path was Python → an
intermediate `server.py` port → the current Go and React implementation, and Bloxsmith
carries no Python on any execution path.

That does not make it independent work. Structure, ordering, control flow and the
template schema were carried over deliberately, as the comment above states, so
Bloxsmith is a derivative work and this notice is an obligation rather than a courtesy.

### Upstream copyright notice, reproduced

**Upstream states its copyright two different ways, and this repository redistributes
both.** Neither is a mistake anyone here can correct, so both are reproduced below,
each labelled with the artefact it comes from.

**In the per-file headers.** 25 of the 33 vendored `.py` files carry this line — 16 of
22 in the toolkit, 9 of 11 in the self-service example:

```
Copyright (c) 2026 Chris Marrison / Infoblox
```

**In the `LICENSE` file.** Both projects gained one on 2026-08-14, and both are vendored
here at the pins in the table above — [`third_party/uddi_automation_toolkit/LICENSE`](third_party/uddi_automation_toolkit/LICENSE)
and [`third_party/uddi_self_service_example/LICENSE`](third_party/uddi_self_service_example/LICENSE),
byte-identical to each other at 1294 bytes. Their first line is:

```
Copyright 2020 Chris Marrison / Infoblox
```

Six years apart, and no `(c)`. Nothing here can settle which one Chris means, so nothing
here picks. Both are retained, which is what BSD-2-Clause clause 1 asks of a
redistribution: quoting only the `LICENSE` would under-report what the vendored code
actually carries, and quoting only the headers would ignore the file upstream
deliberately added.

How each project states its licence — recorded rather than smoothed over, because the
two still differ in the source files:

| Project | Declared in `pyproject.toml` | In source files | `LICENSE` file |
|---|---|---|---|
| `uddi_automation_toolkit` | `BSD-2-Clause` | 15 of 22 `.py` files carry the full clause text below; none use SPDX | [present](third_party/uddi_automation_toolkit/LICENSE) at the pinned commit |
| `uddi_self_service_example` | `BSD-2-Clause` | 9 of 11 `.py` files carry the copyright line plus `SPDX-License-Identifier: BSD-2-Clause`; none carry the full text | [present](third_party/uddi_self_service_example/LICENSE), byte-identical to the toolkit's |

Until the pins were bumped on 2026-08-18, neither repository shipped a `LICENSE` at the
commit vendored here, and the text below had to be transcribed by hand out of the
toolkit's per-file headers. Chris said he would add the files in his reply on
[ccmarris/uddi_automation_toolkit#7](https://github.com/ccmarris/uddi_automation_toolkit/issues/7),
did so, and they now come with the pins. The block below is therefore no longer a
transcription — it is the vendored `LICENSE`, and the hand transcription it replaced
differed from it in exactly one respect: the copyright line above.

The text is reproduced word for word. Upstream wraps it more narrowly and leaves trailing
whitespace on most lines; the trailing whitespace is stripped here and nothing else is
changed, because invisible characters inside a fenced block are unreadable in a diff and
the vendored files linked above are the byte-exact copies.

### BSD 2-Clause License

As it appears in both vendored `LICENSE` files:

```
Copyright 2020 Chris Marrison / Infoblox

Redistribution and use in source and binary forms,
with or without modification, are permitted provided
that the following conditions are met:

1. Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### Staying in sync

`.github/workflows/upstream-sync.yml` checks weekly whether either upstream has moved
past the pinned commit, and opens an issue when it has. It reports the delta only —
nothing is ported automatically, because a Go reimplementation does not track a Python
project commit for commit.

### Not affiliated

Bloxsmith is not affiliated with, endorsed by, or supported by Infoblox. The upstream
copyright line names Infoblox because Chris Marrison's notice does; it is reproduced,
not claimed.
