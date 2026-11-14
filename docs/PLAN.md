# Plan

**Goal:** check the three live-test fixes (PR #452) on the test tenant once the app is updated.

## Steps

- Get an address with a name: reserve one address in the scratch subnet, check it carries the name and the made_by tag, then delete it from Made with Bloxsmith.
- Site lists: the preview refuses a new list while the tenant has 100.
- Add a site to an existing list, then check its delete says "Made by Bloxsmith". Take it back out.
- Touch only scratch items, and the owner's own list with their go. Others share that tenant.

## Done when

Each step passes on the released version and the list holds only what it held before.

## Done

- 2026-11-13 Live test of the November work on the test tenant: Made with Bloxsmith delete, removing one site and a daily proposal passed. It found three defects, fixed in PR #452.
- 2026-11-13 Site lists, five additions (v3.161.0 to v3.164.0): both top lists compared, never-add list, threat check, remove single sites, daily proposals. Changed on the way: the threat check uses Infoblox's bulk lookup, because one Dossier lookup took 26 s; the daily proposal is worked out when Overview or Site lists asks, with no timer.
- 2026-11-13 Made with Bloxsmith: record what the app made, delete anything with one check (v3.160.0). Live-tested 2026-11-13.
- 2026-11-13 Preview works on read-only tenants and says why it is greyed out (v3.159.1); Site lists name check fixed (v3.159.2).
- 2026-11-12 DHCP reservation on Get an address (v3.158.0) and Site lists (v3.159.0).
- 2026-11-10 Kentik traffic row on the search result page.
- 2026-11-06 Best practices page, batch 1.
