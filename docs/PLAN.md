# Plan

**Goal:** five additions to Site lists, which the owner approved on 2026-11-13 from the "think bigger" list. They ship as four releases.

## What the owner decided

- (1) "lets offer both and compare": InfoRank's global top sites and this tenant's own busiest sites, side by side. Own busiest = last 7 days of DNS queries, folded to the site (www.google.com counts as google.com).
- (4) Top X minus a "never add" list, one per tenant, kept in the app.
- (3) Dossier check before adding: a risky site is flagged and left out; the owner can tick it back in.
- (5) Remove single sites from a list.
- (2) Daily sync: each day propose adds and drops, shown on Overview's open-issues board; nothing changes until approved; it runs only while the app runs.

## Approach (Fable's plan, plus Astra's and Codex's safety points)

- Order: (1)+(4), then (3), then (5), then (2). Each is its own release.
- Own traffic: one Cube query (DnsActivityV1 query count by name, 7 days, a few thousand rows), folded with the public suffix list, summed before taking the top X. Labelled an estimate when Cube cut the list short.
- Never-add list: a saved view per tenant, folded the same way, applied again by the server at Apply. Top X minus it does not refill.
- Dossier: checked on the server in a small pool; "could not check" is left out like "risky". Apply refuses a risky or unchecked site the owner did not tick.
- Remove a site: a new kind on the Made with Bloxsmith delete check; Infoblox is told to delete only that item.
- Daily sync: reads only, writes a proposal; drops are proposed only for sites the sync itself added after a successful apply; shows the real dates compared; one proposal per list at a time.

## Done when

- Site lists shows both sources, how they overlap, and lets the owner pick; the never-add list is left out and the preview says how many.
- A risky site is flagged, unticked, and cannot be applied unless ticked.
- A single site can be removed from a list after one check.
- A daily proposal appears on Overview and, once approved, changes only what it listed.
- Unit and browser tests cover each; Codex reviewed each final diff; each release is out.

## Done

- 2026-11-13 Made with Bloxsmith: record what the app made, delete anything with one check (v3.160.0). Live test on SE AMS still to run once the app is updated.
- 2026-11-13 Preview works on read-only tenants and says why it is greyed out (v3.159.1); Site lists name check fixed (v3.159.2).
- 2026-11-12 DHCP reservation on Get an address (v3.158.0) and Site lists (v3.159.0).
- 2026-11-10 Kentik traffic row on the search result page.
- 2026-11-06 Best practices page, batch 1.
