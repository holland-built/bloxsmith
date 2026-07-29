# Dashboard tabs

What each tab in Bloxsmith does, what it reads, and what it can change.

Tabs fall into two groups:

- **Read-only** — Overview, Daily, Network, DNS, Security, Infra, Incidents, Audit. They poll and display; they never write to Infoblox.
- **Write-capable** — Provision, Self-Service, Editor. These create, change, or delete real objects in your tenant. Drift and AI sit in between: Drift only reads, AI reads plus one write action (block a domain).

One property holds across almost every panel on every tab: a feed that failed to load is never rendered the same way as a feed that loaded and came back empty. Where a call errors, times out, or the upstream returns a payload the panel can't trust, the panel says so — "feed unavailable," a chain-verify warning, a fetch-error line — instead of falling back to the same blank state a healthy, empty tenant would produce. If a panel shows no rows, that now means there genuinely are none, not that something failed silently on the way to the screen.

## The write flow

Every surface that writes to Infoblox uses the same two buttons, in the same order:

1. **Preview** — sends the request to the server with a dry-run flag. Nothing is written. The server validates it and returns exactly what it would do; that lands on screen.
2. **Apply** — appears only after a successful preview, and commits it. The button is labelled for the job (Create, Allocate, Provision, Tear down).

Three rules the flow enforces, so you don't have to remember them:

- **A preview never skips the server.** It is a real request, so it catches errors your browser can't see — a malformed MX record, a non-integer TTL, a missing required field.
- **Apply is only reachable from a fresh preview.** There is no way to write without seeing the plan first.
- **Editing any field after a preview hides Apply** and shows "inputs changed — preview again". The plan on screen is dimmed, because it describes the inputs you *had*, not the ones you have now.

If a preview looks wrong, it is wrong — fix the input and preview again.

One honest limit: Provision streams its plan from the server, and the server re-plans when you Apply. So Provision guarantees the *inputs* are unchanged between preview and apply, not the literal bytes. The request/response surfaces (Self-Service, Editor) do submit the reviewed body.

Destructive actions carry extra gates on top of this flow: teardown needs an admin token plus a typed confirmation, and Editor's Delete is a separate two-click armed button that never goes through preview.

| Tab | Writes? | Purpose |
|---|---|---|
| [Overview](#overview) | no | Estate at a glance |
| [Daily](#daily) | no | What needs attention today |
| [Network](#network) | no | IPAM and DHCP detail |
| [DNS](#dns) | no | Query rate, services, DNSSEC, RPZ, DTC |
| [Security](#security) | no | Threats, exposures, lookalikes |
| [Infra](#infra) | no | Host and service health |
| [Incidents](#incidents) | no | SOC triage queue |
| [Audit](#audit) | no | Who changed what |
| [Provision](#provision) | **yes** | Build subnets, sites, demo estates |
| [Self-Service](#self-service) | **yes** | Grab an address, add a DNS record, edit or remove either |
| [Editor](#editor) | **yes** | Direct create/update/delete on objects |
| [Drift](#drift) | no | Template vs. reality |
| [AI](#ai) | one action | Ask questions, look up threats |

---

## Overview

Estate at a glance. Refreshes every 30 seconds.

- **DNS Query Rate — 24h** — average QPS trend, with the change since the first hour in the window.
- **KPI stack** — active leases, total subnets, subnets at 90%+ utilization. Each tile links through to the filtered Network view.
- **Top Consumers** — the 12 subnets with the most addresses *used*. Ranked by count, not percentage, because a wall of 100%-full /32 links tells you nothing.
- **Subnet Heatmap** — utilization per subnet, worst first, capped at 288 cells. /29–/32 infra links are excluded.
- **Host Status** — active / degraded / offline split.
- **Top Subnets by Utilization** — sortable, filterable, exports to CSV.
- **License Inventory** — SKU, state, expiry, and time remaining. Under 30 days is red, under 90 amber.

Where a count could not be fetched for the whole estate, the panel says "loaded rows" instead of implying it covered everything.

## Daily

The morning read. Same 30-second polling.

- **Open Issues** — the single count of things wanting a decision.
- **Security Today** — threat events from the last day.
- **Top Capacity Risks** — the 10 subnets with the least free space, infra links excluded.
- **Hosts Needing Attention** — anything not healthy.
- **DNS Zone Issues** — zones with a configuration problem.

## Network

IPAM and DHCP in detail.

- **Utilization Distribution** — how subnets spread across utilization bands.
- **IPAM Spaces — Top Used** — addresses consumed per space.
- **DHCP Leases** — filterable lease table.
- **Subnet table** — the full list, /29–/32 excluded.

Deep-linkable: `#network?subnet=10.0.0.0`, `#network?minUtil=90`, `#network?focus=leases`.

## DNS

Everything DNS-side, polled every 30 seconds.

- **DNS Query Rate — 24h** and **Query Volume — 7d**.
- **DNS Services** — service inventory and state.
- **DNSSEC Health** — signing posture across zones.
- **RPZ Policy Zones** — response policy zone count and state.
- **DTC Load-Balanced Names** — traffic-director names.

## Security

Threat and exposure posture. Pulls from several CSP feeds, so panels can load at different speeds.

- **Threat Events — by Severity** and **Threat Feed Activity**.
- **Triage Inbox** — events waiting on you.
- **Lookalike Domains** — domains impersonating your brand. Set your brand domain from the header.
- **CTEM Exposure**, **Exposures**, **Exposed Surface**, **CTEM Assets** — external attack surface.
- **Asset Insights** and **Asset Risk**.
- **SOC Insights**.

A panel that shows nothing is telling you the feed returned nothing, not that you are safe. Check the panel note.

## Infra

Host and service health. Host health polls every 15 seconds; the rest every 30–60.

- **Host Health**, **On-Prem Hosts**, **Host Status**.
- **Jobs** — recent job runs.
- **DFP Services** — DNS forwarding proxy state.
- **Asset Discovery** — discovery run status.

Deep-linkable: `#infra?status=offline`.

## Incidents

The SOC queue, polled every 20 seconds.

- **Categories** — click a category to filter the triage list.
- **Triage** — the incident list itself; click a row for detail.
- **SOC Queue** — Infoblox IQ Actions, with per-action detail.
- **Action Volume** — actions per day.

## Audit

Who changed what.

- **Activity Summary** — recent event counts.
- **Audit Log** — actions taken *through Bloxsmith*, from the local audit trail. Each entry is hashed to the one before it, and the panel shows the verdict of that check: chain intact, chain tampered (with the entry where it broke), or could not be verified. A verification that fails to run reads as "could not be verified," never as "intact" — a broken check must not look like a clean bill of health.
- **CSP Portal Audit** — activity in the Infoblox portal itself, from the CSP audit API. External changes show up here, not in the Bloxsmith log. It loads the most recent activity as soon as you open the tab; the search box filters that same feed rather than gating it behind a search.

Two separate logs on purpose: one is what this tool did, the other is what everything else did.

---

## Provision

**Writes to Infoblox.** Builds real objects. Follows the [Preview → Apply flow](#the-write-flow); progress streams line by line as the plan runs.

Your role is shown as a pill at the top right (`VIEWER` / `OPERATOR` / `ADMIN`). Live teardown requires admin.

### Subnet

Carve one subnet out of an existing block.

1. Pick an **IP space**, then a **block** inside it.
2. Set the **CIDR prefix** (e.g. `24`), a **name**, and an optional comment.
3. Optionally tick **Create matching DNS zone**.
4. **Preview** — the log streams the plan without writing. Then **Provision**.

On success you get the new subnet's ID and address.

### Full site

Build an entire site from a template in your template library — address block, DNS zone, subnets, DHCP ranges, and hosts, in one run.

1. Pick a **template**. Optionally override the **IP space** the template would use.
2. **Preview**, read the plan, then **Provision site**.
3. If the site already exists, the run reports *skipped* with a reason rather than duplicating it.

**Tear down this site** deletes what that template provisioned. It is permanent. Preview it like anything else; the live run needs admin plus typing the site name to confirm.

If the template dropdown is empty, no templates are installed — run `scripts/fetch_templates.py`, or use the release archive / container image, which bundle them.

### Seed demo

Bulk-provisions a full demo estate across the regions you tick (AMER, EMEA, APAC) from the template library. Built for demos and lab tenants.

Per-template progress rolls up as `done/total`, with failures listed individually. The finishing message says what actually happened rather than just that the run ended: a clean run says "Seed complete," a mixed one says "Seed partial — *X* of *N* succeeded, *Y* failed," and a run where nothing succeeded says "Seed failed — 0 of *N* template(s) succeeded" instead of the misleadingly cheerful default.

**Tear down demo** deletes every object the seed created in the selected space. The live run needs admin plus typing `DELETE`.

> Do not point Seed demo at a production tenant. It writes many objects fast and the teardown is the only way back.

## Self-Service

**Writes to Infoblox.** Two small forms for the everyday asks, so people don't need the full Editor, plus two panels for fixing up what already exists. The forms use the [Preview → Apply flow](#the-write-flow); Manage Records and Manage Addresses use a lighter edit/delete flow of their own, described below.

### Allocate Address

Take the next free address(es) out of a subnet.

1. Pick **IP space** → **block** (optional) → **subnet**.
2. Set how many addresses you want, and an optional name.
3. **Preview** shows what would be allocated. **Allocate** takes it.

### Create DNS Record

Add a record to an existing zone.

1. Pick the **zone** and record **type** (A, AAAA, CNAME, MX, TXT, SRV, PTR, NS, CAA).
2. Fill in **name** (`@` for the zone apex), **value**, and an optional TTL.
3. **Preview** sends it to the server for validation and shows the record it would write. **Create** writes it.

The preview shows the record as the *server* parsed it, which is often not what you typed — an SRV value of `10 5 5060 sip.example.com` comes back as separate priority, weight, port, and target fields. Worth a glance.

### Manage Records

Edit or delete a record that already exists in a zone.

Pick a **zone**, then **Edit** any editable row (read-only record types are marked as such and skip straight past Edit/Delete). Change value, TTL, or comment and hit **Preview** — same server-validated preview as the create form. **Update** re-reads the record right before writing and compares it against the copy the preview was built from; if the two don't match, Apply is refused with "record changed since you previewed — preview again" rather than overwriting whatever is there now.

**Delete** is a two-click arm: the first click turns the button into "Click again to delete `<type> <name> -> <value>`" naming the exact record, and it disarms itself after four seconds if you don't confirm.

### Manage Addresses

Release an allocated address back to the pool.

Pick an **IP space**, then a **subnet**, to list its addresses. **Release** is armed the same way as Manage Records' delete — one click shows "Click again to release `<address>`", the second click sends it, and the arm expires after four seconds either way.

## Editor

**Writes to Infoblox.** Direct create, update, and delete on individual objects. The blunt tool — use Provision or Self-Service when they cover the job.

Six object types: DNS Zone, Subnet, Address Block, DHCP Range, Host, and Tags (block re-tag).

**How the mode is decided:** the **Object ID** field at the top.

- Leave it blank → the form **creates** a new object.
- Paste an existing object ID → the form **updates** that object, and a Delete button appears.

**The flow:** hit **Preview**. The exact request body renders below. If it is right, hit **Create** (or **Update**). See [the write flow](#the-write-flow).

**Delete** is separate and does not go through preview. It is armed by two clicks — the first changes the button to "Click again to permanently delete" and disarms itself after four seconds. There is no undo.

Deep-linkable and prefillable from other tabs: `#editor?type=subnet&id=abc123`.

> Subnets and address blocks created here are ad-hoc. No site template knows about them, so Drift will report them as extra.

## Drift

**Read-only.** Compares a site template against what actually exists in Infoblox.

1. Pick a **template**, optionally override the **IP space**.
2. **Check drift.**

The result is either `✓ in-sync` or a count of drift items, grouped by category and sorted worst-first. Each item is tagged:

- **missing** — the template defines it, Infoblox doesn't have it.
- **changed** — it exists, but a value differs from the template.
- **extra** — it exists in Infoblox and the template does not define it.

Drift never fixes anything. To close a gap, re-provision the site (missing) or edit/delete the object (changed, extra).

## AI

**Reads, plus one write action.** Two independent panels.

### Ask AI

Natural-language questions about your own data — "which subnets are nearly full?", "what changed in the last 24 hours?". Suggested questions are one click.

Answers show the tools the model called underneath, so you can check where a number came from. Requires an LLM key with tool-calling; see the AI query box section in the [README](../README.md). Without one, this panel returns an error and everything else in the dashboard still works.

If the vault is locked, queries return "Vault locked — unlock to query."

### Threat lookup

Enter a domain, IP, or host. Returns matching threat-intel entities plus a dossier for the entity.

**Block domain** adds the looked-up domain to your blocking policy — a real change to your tenant. It needs a dashboard token (set it under ⋯ Settings) and can be undone with **Unblock** in the same place.

---

## Security posture

The five Provision/teardown streams (`#provision`'s subnet/site/seed runs and their teardowns) are `EventSource` GET requests, because a browser's `EventSource` can't send a mutating verb or custom headers — but a GET is also what a hostile page could fire blind. Those five routes carry a stricter gate than the rest of the write surface: a request must carry `Sec-Fetch-Site: same-origin` (or `none`) or a matching Origin/Referer. A bare loopback request with no fetch-metadata at all is refused, where the ordinary write endpoints still trust it. Setting `DASHBOARD_TOKEN` sidesteps this check entirely — since `EventSource` can't set the `X-Auth-Token` header, the dashboard instead passes the token on the stream URL as `?token=`.

Separately, the server checks the `Host` header on every request against an allowlist (`localhost`, `127.0.0.1`, `[::1]`, and whatever it's bound to); an unrecognized `Host` gets `421 Misdirected Request`, which stops DNS-rebinding attacks. A wildcard bind (`HOST=0.0.0.0`, the Docker default) can't know its own hostname, so that check stands down until you set `ALLOWED_HOSTS`. Full variable reference and the rest of the deployment security notes are in [docs/DEPLOYMENT.md](DEPLOYMENT.md#security-notes) — this section only points at what exists, not how to configure it.
