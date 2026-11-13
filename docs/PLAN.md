# Plan

**Goal:** Bloxsmith keeps a record of everything it creates and deletes, can delete it again, and can delete other items of the same kinds, always after one "are you sure" step. Started 2026-11-13.

## What the owner decided

- "the app should be able to see what was created with the app so some breadcrumb when we create and delete and it should also be able to delete other things if so desired. all deletes need a one step are you sure: this was created with the tool so it's safe / this was not, are you sure, for both".
- Both a new page "Made with Bloxsmith" (Change menu) and a short list on each page that creates things.
- Tag `made_by=bloxsmith` in Infoblox where tags exist (DNS and IP items). Lists and policy rules carry it in their description.
- "Other things" = the kinds Bloxsmith makes: DNS names, IP addresses, DHCP reservations, networks, zones, hosts, DHCP ranges, custom lists, policy rules. Not policies, IP spaces or address blocks.
- Automate's earlier history counts as made by Bloxsmith; earlier Get an address and Site lists items do not.

## Approach (Fable's plan, plus Astra's tenant field)

1. **Record:** extend the runs ledger (`go/internal/runs`). Run gets `Source` and `Tenant`; Object gets kinds `fixed_address`, `custom_list`, `policy_rule` (with policy id and action). A delete is recorded too.
2. **Creates:** Get an address and Site lists write a run, like Automate does. Dry runs record nothing. Adding sites to an existing list is not a create.
3. **Made by Bloxsmith** = the exact id is in the ledger. The tag is a label only, because tags can be inherited.
4. **Delete:** `POST /api/made/delete {kind,id,dry}`. Preview says whether Bloxsmith made it, and what blocks it. Live needs `confirm` equal to what the preview found, so the one confirm step cannot be skipped. A list in use by a policy is refused. A rule is dropped only if the policy is unchanged since the preview.
5. **UI:** one shared confirm step (also on Automate's Remove), the new page with a finder for other items, and a short list on Get an address, Site lists and Automate.

## Done when

- Creating a reservation, list and rule on SE AMS shows each on the new page and on its own page, with the tag or description in Infoblox.
- Deleting each one asks once, says "made by Bloxsmith", and removes only that item; the policy keeps every other rule.
- Deleting an item Bloxsmith did not make asks once with the "not made by Bloxsmith" wording.
- Each delete leaves a record. Unit and browser tests cover it; Codex reviewed the final diff; the bloxsmith-test items are gone from SE AMS.

## What happened

- Codex round 1: the confirm code now also binds Infoblox's updated_at (or a hash of a list's items), so an edit between the preview and the click is refused; a rule is not removed when the policy has no ETag. Declined: closing the old API delete routes (the app no longer uses them for these kinds) and treating older history as unproven (owner chose to count it).
- Codex round 2, declined as follow-ups: the milliseconds between the last read and the DELETE, and a confirm code a signed-in operator could compute.
- The "Made here" list on Get an address, Editor and Site lists is a headed section under the form, not a panel, because those pages have no panels since 2026-11-11.
- Known limits: addresses from next-free-IP carry no made_by tag; whether Infoblox honours If-Match on a policy save is unverified.

## Done

- 2026-11-13 Preview works on read-only tenants and says why it is greyed out (v3.159.1); Site lists name check fixed (v3.159.2).
- 2026-11-12 DHCP reservation on Get an address (v3.158.0) and Site lists (v3.159.0).
- 2026-11-10 Kentik traffic row on the search result page.
- 2026-11-06 Best practices page, batch 1.
