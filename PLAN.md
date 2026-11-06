# Plan

**Goal:** a Best practices page in Bloxsmith that checks the tenant against Infoblox design rules
(the checks in a friend's Infoblox CSP bundle) and lists what to fix. Planned 2026-11-06; batch 1 built the same day.

## What the user decided (2026-11-06)

- Option 2 of three: add some of his checks to Bloxsmith, rather than running his bundle inside it.
- Plan first, then code.
- Still to ask him: OK to reuse his check rules. The rules are rewritten in Go here; none of his
  code is copied.

## The page

- Name "Best practices", under **Status** next to Overview and Daily. One sentence intro, the
  Help button, read-only like Drift.
- One row per check: severity (High, Medium, Low, Info), a plain title with the count ("2 Grid
  Masters with no HA and no candidate"), one line on why it matters, and a fold-out list of the
  affected names, each linking to where it is fixed (Infra or Editor).
- A check whose data could not be read says "Couldn't check" with the reason, never "no problems".
- Checks that pass are listed at the bottom as passed, so a short list doesn't look like a broken page.
- Computed on the server (a Go package, one endpoint `/api/best-practices`), cached like the other
  feeds.

## The rule every check follows

A check reports a problem only when the data proves it. When the data can't prove it either way,
the check says "Couldn't tell" and why (Codex, plan review 2026-11-06). In practice:

- Read every page of a list. If a list is capped or a read fails, the checks that need it say
  "Couldn't check", never "passed".
- Never cache a failed or partial read as a passed check.
- Each affected item links only to a page that can show or fix that object. NIOS objects get no
  Editor link.

## Batch 1: three checks the data proves directly

1. High: hosts offline or in error. Read from `/api/infra/v1/hosts`, the complete list:
   `detail_hosts` leaves out Infoblox-managed (XaaS) hosts. Settle its status field on the live
   tenant first; if it has none, the title says "on-prem hosts" so it doesn't claim more.
2. High: Grid Master with no HA and no candidate. Reported only when the number of members
   visible in the Portal equals the grid's own count (the `host/grid_pnode_count` tag).
   Otherwise "Couldn't tell", because a candidate may exist that the Portal doesn't show.
3. Medium: DHCP HA groups in Advanced Active/Passive mode (`dhcp/ha_group` mode, a direct field).

## Batch 2: each one checked against the live tenant first

Each needs a fact settled by a direct API read before it is built. If the fact doesn't hold,
the check is dropped, not guessed at.

4. Zones served by no DNS server: count direct hosts, name server groups and inherited
   assignment. Settle how inheritance shows in `auth_zone`.
5. Forward-only to a single forwarder: settle whether forward zones inherit forwarders.
6. DNS servers forwarding to each other: only a direct two-way loop in the same view.
7. Subnets with no DHCP failover: settle how a subnet names its DHCP server or HA group.
8. Grid Master Candidate in the Grid Master's site: settle what `site_id` means.

Later, if wanted: Grid Master serving DNS or DHCP, hosts that never joined, zones served from one
site, external views on NIOS-X, anycast across sites.

## Done when

1. `#best-practices` shows batch 1 against the faked backend, each check with its count, why,
   and affected names, and passed checks listed as passed.
2. Each check has a Go unit test with a case that finds the problem and a case that passes.
3. A failed or capped read shows "Couldn't check" for the checks that need it; the others still show.
4. On the live tenant the page loads and each batch 1 count matches a direct API read.
5. Batch 2 ships the same way, as a second PR.

## What happened (batch 1)

- Live reads settled two plan points: `/api/infra/v1/hosts` has no status field, so check 1 uses
  `detail_hosts` and says "on-prem hosts". Grid names repeat across grids, so a grid is its name
  plus its Grid Master address. `host/ha_pair` marks an HA Grid Master.
- On the live tenant each of the three counts matched a separate count from a direct API read.
- Codex code review, two rounds, four false-pass or false-alarm cases fixed: a list counts as
  complete only when the API's total equals the rows read; a grid member with no node id or no
  role makes that grid "couldn't tell".

## Done

- 2026-11-05: setup checklist after the first key (#376).
