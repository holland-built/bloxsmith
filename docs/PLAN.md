# Plan

**Goal:** live-test the November Site lists and delete work on the SE AMS tenant, once the installed app is updated.

## Steps

- Made with Bloxsmith (v3.160.0): make a scratch reservation, list and log rule named bloxsmith-test, then delete each from the page.
- Remove one site from a list (v3.163.0): Infoblox's delete-items field is not yet proven live; the page reads the list back, so a wrong field shows as "still in the list".
- Daily proposal (v3.164.0): turn it on for the scratch list, check the Overview row, approve, then stop it.
- Touch only bloxsmith-test items. Others share that tenant.

## Done when

Each step above ran on SE AMS and the scratch items are gone.

## Done

- 2026-11-13 Site lists, five additions (v3.161.0 to v3.164.0): both top lists compared, never-add list, threat check, remove single sites, daily proposals. Changed on the way: the threat check uses Infoblox's bulk lookup, because one Dossier lookup took 26 s; the daily proposal is worked out when Overview or Site lists asks, with no timer.
- 2026-11-13 Made with Bloxsmith: record what the app made, delete anything with one check (v3.160.0). Live test on SE AMS still to run once the app is updated.
- 2026-11-13 Preview works on read-only tenants and says why it is greyed out (v3.159.1); Site lists name check fixed (v3.159.2).
- 2026-11-12 DHCP reservation on Get an address (v3.158.0) and Site lists (v3.159.0).
- 2026-11-10 Kentik traffic row on the search result page.
- 2026-11-06 Best practices page, batch 1.
