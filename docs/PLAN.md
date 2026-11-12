# Plan

**Goal:** reserve an address for a device (DHCP), and build a domain list from InfoRank, a CSV or pasted text and attach it to a security policy with any action. Started 2026-11-12.

## What the owner decided

- DHCP reservation is a choice on Get an address (2026-11-12, "1 ok").
- Lists: "pull from info ranks push to a policy but dont lock me in to log block allow etc give me all the options and upload a csv for the same thing". All six actions, any position.
- Live tests on Infoblox SE AMS with scratch items named bloxsmith-test, removed afterwards.

## Approach (Fable's plan, picked over Astra's for less code; Codex's nine attacks folded in)

1. **DHCP** (PR 1): `dhcp:{mac,name}` on `/api/selfservice/allocate`, count must be 1. Preview checks the MAC has no reservation yet. Live: next free IP, then `POST /api/ddi/v1/dhcp/fixed_address`, then DNS if asked. A failed reservation releases the IP; an unreadable one keeps it and says "not confirmed".
2. **Lists** (PR 2): Security tab card. Source InfoRank top X (`/tide/api/data/set/inforank`, cached 24 h) | CSV | paste. New list or add to an existing one, never replace. Policy, action, position. Preview returns a fingerprint of the policy rules; Apply refuses if they changed, checks for an existing rule BEFORE writing the list, looks a new list up by name before creating it, re-reads the policy after the PUT and reports any lost rule.

## Done when

- Get an address: preview says which address and MAC; Allocate creates the reservation, and it shows in Infoblox with that MAC. A MAC already reserved is refused in the preview.
- Lists: top 100 InfoRank, a 3-line CSV and a pasted list each preview the exact domains, rule and rule order; Apply creates the list and the rule in the chosen place with the chosen action, and the policy keeps every other rule.
- Unit and browser tests cover preview, apply, partial failure and refusals; Codex reviewed each final diff; scratch items deleted from SE AMS.

## Done
 when

- Searching `172.16.0.210` shows about 6 kb/s out and 52 b/s in, top destination 10.67.70.10 UDP/9995, and BGP peers 172.16.0.221/.222 on TCP/179.
- No key set: the section says Kentik is not set up and where to set it. A failed read says unavailable. Neither ever says "no traffic".
- A hostname search shows the section as not applicable and sends nothing to Kentik.
- Unit and browser tests cover all of those states; Codex reviewed the final diff.

## What happened

- Built as planned. Codex asked for two guards, both added with tests: all four answers must come back, and every row must carry a rate, or the read is a failure.
- Live check 2026-11-10: 172.16.0.210 showed 5.5 kb/s out, 48 b/s in, NetFlow to 10.67.70.10 UDP 9995 and BGP with .221/.222 on TCP 179.
- Next: the four MCP items (host config viewer, setup check, chart anything, search everything), then the page restyles.

## Done

- 2026-11-10 Kentik traffic row on the search result page.

- 2026-11-06 Best practices page, batch 1.
