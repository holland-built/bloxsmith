# 0002 — The dossier page fans out live to five sources on every query

## Context

The dossier page answers "everything this tenant knows about one indicator" by
reading five independent sources: Assets (`/api/csp/assets`), DNS
(`/api/search/dns`), IPAM (`/api/search/ipam`), Threat intel (`/api/dossier`) and
Recent changes (`/api/csp-audit`). They are unrelated upstream systems with unrelated
latencies and unrelated capability gaps, and this build measured how unrelated: on
2026-08-06, against the live tenant, `/api/csp-audit` took 35.2 seconds while the
other four sections had already painted. The capability gaps are just as uneven and
were found by probing rather than by reading documentation — the DNS field the plan
originally named, `absolute_name_in_zone`, does not exist on this tenant (CSP answers
400 `Unknown field`), and `absolute_name_spec` plus `dns_rdata` were found by testing
fields one at a time; the unparented IPAM filter `address=="<q>"` was probed and
accepted; and `/api/csp/assets?q=` fails upstream for any IP or hostname on this
tenant although it answers normally for plain names. So no single source can be
treated as representative of the others, and no source can be allowed to hold up the
page.

## Decision

Each of the five sources owns its own fetch, its own React state and its own row in
the ledger (`useSource` in `ui/src/components/DossierPage.jsx`). There is no combined
loading state anywhere on the page: five stub rows paint on the first render before
any request is issued, and each row swaps its own cells in place when its own answer
arrives. Every section answers HTTP 200 and puts its verdict in the body
(`go/internal/server/search.go`), which the page reduces to one self-describing state:
`ok`, `none`, `error`, `unsupported`, or `na`. `unsupported` and `error` are the two
UNKNOWN outcomes and are rendered distinctly from `none`, because showing "no DNS
record" when the truth is "we could not ask" is the specific misread this page exists
to prevent. `na` means the question does not apply to a query of this shape and was
never asked: IPAM is skipped entirely for hostname queries, because its upstream
filter is `address=="<q>"` and the live tenant answers 500 to it, which the page had
been painting as "Unavailable" — telling an operator a healthy system was broken.
`ui/src/lib/indicator.js`'s `isIPQuery` is the gate, and it is a deliberate port of
the Go classifier so the client and server cannot disagree about what a query means.

## Alternatives rejected

**A search index or cache in front of the five sources.** It would make every section
answer at index speed and remove the 35-second wait. Rejected because it introduces a
freshness contract this page cannot honour: the dossier is read during incident work,
where a stale answer about DNS or recent changes is worse than a slow one, and the
sources give no change feed to invalidate against. It also adds a system to operate
and backfill for a page that reads five endpoints that already exist.

**A single aggregating backend endpoint returning all five sections.** Fewer requests,
one response shape, no per-source state in the client. Rejected because it converts
the page's latency from "the slowest source the user is waiting on" into "the slowest
source, full stop" — with the measured 35.2-second audit call in the set, every
dossier load would block for 35 seconds behind four sections that were ready in a
fraction of it. Streaming or partial responses would recover this, at which point the
endpoint is a fan-out proxy in front of the same five calls with a protocol added.

**Treating a failed source as an empty result.** Simplest possible client, two states
instead of five. Rejected outright: it is the failure mode the whole design is built
against, and this tenant produces it routinely — the assets route fails upstream for
every IP and hostname query, so a two-state page would report "no asset carries this"
about a question that was never successfully asked.

## Consequences

Page latency is bounded by the slowest source the operator actually waits for, not by
the sum of five, and the four fast sections are readable while the audit call is still
in flight. There is no index to keep fresh and no cache invalidation to reason about;
every answer is as current as the upstream that produced it.

Per-source capability gaps surface to the operator as themselves. A tenant that cannot
answer the assets query says so, in that row, while the other four rows still show
real data — no aggregate hides it and no aggregate is falsely degraded by it.

The costs are that the page issues five requests per query rather than one, that each
new source adds an entry to `SOURCES` plus its own state-mapping rather than a field
in a shared response, and that a slow source stays slow: nothing on this page makes
`/api/csp-audit` faster, it only stops that call from delaying the rest. The verdict
guard for the threat row is also duplicated rather than shared — `dossierState` mirrors
the predicate in `DossierPanel.jsx`, and the panel is the original, so a change there
must be followed here.
