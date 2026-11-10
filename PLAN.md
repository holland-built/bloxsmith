# Plan

**Goal:** search an IP in Bloxsmith and see what Kentik sees it doing in the last hour, next to what Infoblox knows about it. Started 2026-11-10.

## What the owner decided

- Kentik first, then the four MCP items, then the page restyles (2026-11-10).
- Kentik token and login email given; stored in this Mac's Keychain for probes. The app itself takes them in Settings like the Axur key.

## Approach (Fable and Astra agreed on the shape; one-request query verified live)

- Settings: Kentik email + token in the vault beside Axur (`POST /api/vault/kentik`), env fallback `KENTIK_API_EMAIL` / `KENTIK_API_TOKEN`, a section in TenantManager.
- Server: `dashboard/kentik.go`, one POST to `/api/v5/query/topXdata` holding four queries (total out, total in, top destinations, top sources) for the last hour. Own `net/http` client, because Kentik wants `X-CH-Auth-Email` / `X-CH-Auth-API-Token`. Cached 5 minutes per IP and credential; failures never cached. Route `GET /api/kentik/traffic?q=<ip>`.
- Page: a sixth section on the search result page, IPv4 only.

## Done when

- Searching `172.16.0.210` shows about 6 kb/s out and 52 b/s in, top destination 10.67.70.10 UDP/9995, and BGP peers 172.16.0.221/.222 on TCP/179.
- No key set: the section says Kentik is not set up and where to set it. A failed read says unavailable. Neither ever says "no traffic".
- A hostname search shows the section as not applicable and sends nothing to Kentik.
- Unit and browser tests cover all of those states; Codex reviewed the final diff.

## Done

- 2026-11-06 Best practices page, batch 1.
