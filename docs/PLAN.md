# Plan

**Goal:** "Overlapping ranges" on the Network page, and an AI tool for it. The owner asked "do we show overlapping address spaces?" and approved:

1. One row per shared range, how many IP spaces use it, biggest first; clicking a row lists the space names.
2. Only each space's outermost blocks and subnets count, so nested ranges in one space are not double counted.
3. A new read-only card on the Network page. Nothing in Infoblox changes.
4. The in-app AI assistant gets a tool (`get_overlapping_ranges`) that returns the same list.

**Done when:**

1. Go unit tests for the grouping, written to fail first, pass: equal-start /8 and /16 in one space keeps only the /8; A /8, B /16, C /16 is one group of 3; one space only is no group; IPv4 and IPv6 never group; a total that doesn't match the rows is an error; an unreadable cidr is an error. Plus a handler test and an AI tool test. `go test ./...` and `go vet ./...` are clean.
2. An e2e spec for the card (stubbed API) passes with E2E_SKIP_LIVE=1: rows biggest first, a click shows the spaces, the error state shows the plain message. The existing Network specs still pass.
3. The server, run from the branch against the live tenant, answers `/api/ipam/overlaps` with its time, group count and top 3 rows recorded, with screenshots at 1440x900 and 390 wide.
4. `scripts/needs-tag.sh` says what it says, pasted in the report.

## Done

- 2026-11-13 Live-test fixes (v3.164.1) checked live: a named address carries its name and made_by tag, the preview refuses a 101st site list, and a site added to an existing list says "Made by Bloxsmith". Scratch items removed.
- 2026-11-13 Live test of the November work on the test tenant: Made with Bloxsmith delete, removing one site and a daily proposal passed. It found three defects, fixed in PR #452.
- 2026-11-13 Site lists, five additions (v3.161.0 to v3.164.0): both top lists compared, never-add list, threat check, remove single sites, daily proposals. Changed on the way: the threat check uses Infoblox's bulk lookup, because one Dossier lookup took 26 s; the daily proposal is worked out when Overview or Site lists asks, with no timer.
- 2026-11-13 Made with Bloxsmith: record what the app made, delete anything with one check (v3.160.0). Live-tested 2026-11-13.
- 2026-11-13 Preview works on read-only tenants and says why it is greyed out (v3.159.1); Site lists name check fixed (v3.159.2).
- 2026-11-12 DHCP reservation on Get an address (v3.158.0) and Site lists (v3.159.0).
- 2026-11-10 Kentik traffic row on the search result page.
- 2026-11-06 Best practices page, batch 1.
