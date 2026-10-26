# Dashboard tabs

What each tab in Bloxsmith does, what it reads, and what it can change.

Tabs fall into two groups:

- **Read-only** — Overview, Daily, Network, DNS, Security, Infra, Assets, Incidents, Audit, Changes. They poll and display; they never write to Infoblox. Assets is the one exception to the polling half: it re-reads only when you ask it to, for the reason given in its own section.
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
| [Overview](#overview) | no | Your network at a glance |
| [Daily](#daily) | no | What needs attention today |
| [Network](#network) | no | IPAM and DHCP detail |
| [DNS](#dns) | no | Query rate, services, DNSSEC, RPZ, DTC |
| [Security](#security) | no | Threats, exposures, lookalikes |
| [Infra](#infra) | no | Host and service health |
| [Assets](#assets) | no | Every discovered asset, searchable and paged |
| [Incidents](#incidents) | no | SOC triage queue |
| [Audit](#audit) | no | Who changed what |
| [Changes](#changes) | no | What changed in the last 24 hours |
| [Provision](#provision) | **yes** | Build subnets, sites, demo networks |
| [Self-Service](#self-service) | **yes** | Grab an address, add a DNS record, edit or remove either |
| [Editor](#editor) | **yes** | Direct create/update/delete on objects |
| [Drift](#drift) | no | Template vs. reality |
| [AI](#ai) | one action | Ask questions, look up threats |
| [Build a chart](#build-a-chart) | no | Make a DNS or security chart by picking from menus |

## Rearranging panels

Every tab rearranges, and each one remembers its own arrangement — moving a panel on Network changes nothing on DNS. Provision keeps three separate arrangements, one each for Subnet, Full site and Seed demo, because those are three different pages behind one tab.

- **Move** — open the ⋯ menu in a panel's header and drag **Move**. Press Escape while dragging to give the drag up. Without a mouse: Tab to ⋯ and press Enter, Tab to **Move** and press Enter, move with ← and →, then Enter to keep the new position or Escape to put it back.
- **Resize** — drag a panel's right edge. Press Escape while dragging to keep the width it had. In keyboard move mode, ↑ and ↓ do the same thing.
- **Take a panel off the page** — **Take off the page**, in the same ⋯ menu. Nothing is deleted and no data is lost; that tab simply stops drawing the panel until you put it back.
- **Arrange panels** — a button above the panels opens a window called "Arrange this page". It lists what is on the page, in the order the page is actually in, and separately anything that is off it. Drag a row up or down, or use its **Move up** and **Move down** buttons, to reorder. **Take off the page** and **Put back on the page** do the hiding and the undoing. A panel you put back lands at the *end* of the page rather than where it used to be, and the window says so. This window is also where the whole feature is explained in words, for anyone who has not met a ⠿ grip before.
- **Saving** — there is no Save button, and nothing to remember to press. Every move, every resize and every hide is written as soon as you let go, the page confirms that it saved rather than leaving you to guess, and the arrangement comes back on your next visit and after a server restart.

Two tabs are quieter than the rest, and deliberately so. **Editor** draws a single panel and always will. **Drift** draws one until you run a check, and a second one appears with the result. A lone panel has nowhere to move to, so on those tabs there is no ⠿ handle and no **Arrange panels** button until a second panel is actually there — an affordance for a gesture that cannot do anything is a lie. Resize and ✕ still work on a single panel, and if you do take that one panel off the page, the **Arrange panels** button appears so you can bring it straight back.

Provision, Self-Service, Editor and Drift also have an **On this page** list on the left, on wide screens. It names every panel on the page, and clicking a name jumps to that panel. The panel you are looking at is marked in the list. The list follows the page as it changes, for example when you switch Provision between Subnet, Full site and Seed demo.

Panels cannot be created or deleted: the set on each tab is fixed and ships with the app, and **Take off the page** only hides one. A panel that is missing without you having hidden it is missing because the service behind it was not detected on this tenant, and when that happens the tab says so in a row that offers to show it anyway.

---

## Overview

Your network at a glance. Refreshes every 30 seconds.

- **Headline numbers**: a row of tiles across the top: DNS queries per second, hosts, hosts offline, subnets at 90% or more, active leases, and security events that are critical or high. A tile that counts something bad is red or amber when there is any and green when there is none. A count that could not be read is a dash with no colour, and says "unavailable". Click a tile to jump to its panel, or to the tab that holds the detail.
- **DNS Query Rate — 24h** — average QPS trend, with the change since the first hour in the window.
- **Top Consumers** — the 12 subnets with the most addresses *used*. Ranked by count, not percentage, because a wall of 100%-full /32 links tells you nothing.
- **Subnet Heatmap** — utilization per subnet, worst first, capped at 288 cells. /29–/32 infra links are excluded.
- **Host Status** — active / degraded / offline split, with the hosts that are not active named underneath, worst first.
- **Services and incidents** — each Infoblox service with how many of its machines are online, then the open incidents, worst first, with links to the Incidents and Infra tabs. A feed that is down says so rather than showing an empty list.
- **Top Subnets by Utilization** — sortable, filterable, exports to CSV.
- **License Inventory** — SKU, state, expiry, and time remaining. Under 30 days is red, under 90 amber.

Where a count could not be fetched for the whole network, the panel says "loaded rows" instead of implying it covered everything.

## Daily

The morning read. Same 30-second polling.

- **Open Issues** — the single count of things wanting a decision.
- **Security Today** — threat events from the last hour, 50 at most.
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

Threat and exposure posture. Pulls from several CSP feeds, so panels can load at different speeds. The Triage Inbox comes first, because that is where you act.

- **Triage Inbox** — events waiting on you.
- **Threat Events — by Severity** and **Threat Feed Activity**.
- **Lookalike Domains** — domains impersonating your brand. Set your brand domain from the header.
- **Axur Supplier Risk**: problems Axur found in your suppliers, worst first. One row per supplier.
- **CTEM Exposure**, **Exposures**, **Exposed Surface**, **CTEM Assets** — external attack surface.
- **Asset Insights** and **Asset Risk**.
- **SOC Insights**.

A panel that shows nothing is telling you the feed returned nothing, not that you are safe. Check the panel note.

### Axur, in four points

Axur is a separate company from Infoblox, with its own subscription and its own key.

- **Where the key goes.** Paste it under ⋯ Settings, encrypted alongside your Infoblox keys. `AXUR_API_KEY` also works, for deployments that never open a vault; the saved one wins when both are set. The key belongs to the installation, so switching Infoblox accounts does not change it.
- **What the order means.** Sorted by credentials exposed, the only figure that compares fairly between suppliers. Axur's other measures count different things, so the biggest number is not the worst problem.
- **What "Types affected" means.** How many categories of problem, not how many problems. It sits beside the ranking rather than driving it.
- **When there is no number.** A dash means nothing was counted, and the panel says why: no key, a locked vault, an account code it could not work out, or a failed read. An empty list says "no suppliers monitored in Axur", which is not the same as "no problems found".

## Infra

Host and service health. Host health polls every 15 seconds; the rest every 30–60.

- **Host Health**, **On-Prem Hosts**, **Host Status**.
- **Jobs** — recent job runs.
- **DFP Services** — DNS forwarding proxy state.
- **Asset Discovery** — discovery run status.

Deep-linkable: `#infra?status=offline`.

## Assets

The inventory behind the counts. Infra's **Asset Discovery** tile and Security's **Asset Insights** tile can both tell you how many assets there are; this tab is where you find out which ones.

- **Asset Inventory** — the total, and a chip per asset type with its own count. Click a chip to filter the list to that type; click the same chip again to clear it. The chips are the types *your tenant actually has*, not a catalog of every type that exists, so a chip never filters to nothing.
- **Assets** — the list itself: name, type, provider, vendor, last seen. Sortable on any of the five columns, 50 rows to a page.
- **Row detail** — click any row for the fields too sparse to justify a table column: OS, IP addresses, MAC addresses, model, location. OS is recorded for roughly a quarter of assets, so as a column it would be mostly empty; on the one asset you asked about it is often the first thing you want.

Search matches the asset **name** and is case-insensitive. It runs on the server against every asset, not against the page on screen — searching from page 4 of 48 searches all 48 pages, and puts you back on page 1 of the result.

Everything is server-side: the search, the type filter, the sort and the paging. The browser is never sent 2,000-plus assets to show you fifty of them.

**This tab does not poll, and that is deliberate.** Every other read-only tab refreshes itself on a timer because the thing it watches changes minute to minute. Asset inventory changes when a discovery sync runs, so a timer here would re-fetch the same rows over and over — and it would do it while you are half-way down page 4, which is the one moment a table must not move under you. Use **Refresh** when you want it re-read. Refresh means "ask again"; the server keeps its own short-lived cache, so two refreshes in quick succession can honestly return the same rows.

A panel that says **unavailable** means the read failed and names the reason. A list that is genuinely empty says so in different words. The two are never rendered the same way, so an empty table here means your filter matched nothing — not that something broke quietly on the way to the screen. The same rule applies to the total: if the count query fails but the list does not, the total is shown as unavailable rather than as a number, because a wrong total is worse than no total.

## Incidents

The SOC queue, polled every 20 seconds.

- **Categories** — click a category to filter the triage list.
- **Triage** — the incident list itself; click a row for detail.
- **Severity Counts**: how many of the loaded incidents are critical, high, medium and low.
- **SOC Queue** — Infoblox IQ Actions, with per-action detail.
- **Action Volume** — actions per day.

## Audit

Who changed what. The Audit Log comes first, with the Activity Summary beside it on wide screens.

- **Audit Log** — actions taken *through Bloxsmith*, from the local audit trail. Each entry is hashed to the one before it, signed with an HMAC under a key kept outside the log's directory, and covered by a separately sealed count of how many entries the chain should hold. The panel shows the verdict of that check: chain intact, chain tampered (with the entry where it broke **and why** — a forged entry, a truncated tail, an altered seal), or could not be verified (**with the reason** — an unreadable file, or a key this process does not hold). A verification that fails to run reads as "could not be verified," never as "intact" — a broken check must not look like a clean bill of health. A lost or rotated key is could-not-verify, never tampered: the chain may be perfectly intact, we just cannot check it, and saying otherwise would be an invented accusation. What the key does and does not protect against is documented in [DEPLOYMENT.md](DEPLOYMENT.md#the-audit-chains-key). The panel loads the newest 2,000 entries. When the log is longer, a line says how many are shown, and **Load older** fetches the page before them. The filter box searches only what has been loaded.
- **Activity Summary** — recent event counts.
- **CSP Portal Audit** — activity in the Infoblox portal itself, from the CSP audit API. External changes show up here, not in the Bloxsmith log. It loads the most recent activity as soon as you open the tab; the search box filters that same feed rather than gating it behind a search.

Two separate logs on purpose: one is what this tool did, the other is what everything else did.

---

## Changes

What changed in the portal in the last 24 hours. It reads the same CSP audit feed as the Audit tab's portal panel, limited to one day and grouped by what was touched.

- **Notability**: four questions about the day: deletions, failed changes, changes made out of hours, and new actors. Each one is answered, marked None, or marked Unknown when the data cannot answer it. An actor counts as new if it made changes in the recent half of the window and none in the earlier half; there is no history before the window to check.
- **Changed objects**: the changes grouped by the object they touched, newest group first. Deletions and failures are shown in red.

It shows at most the 500 most recent events in the last 24 hours. The portal returns no more than that in one request, so on a busy day the oldest changes in the window are not shown, and the page says so when that happens.

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

Bulk-provisions a full demo network across the regions you tick (AMER, EMEA, APAC) from the template library. Built for demos and lab tenants.

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

**Reads, plus one write action.** Two independent panels, side by side on wide screens: Ask AI on the left and Threat lookup beside it. On a phone they stack.

### Ask AI

Natural-language questions about your own data — "which subnets are nearly full?", "what changed in the last 24 hours?". Suggested questions are one click.

Each answer is labelled **AI-generated**, and shows the tools the model called underneath, so you can check where a number came from. Requires an LLM key with tool-calling; see the AI query box section in the [README](../README.md). Without one, this panel returns an error and everything else in the dashboard still works.

If the vault is locked, queries return "Vault locked — unlock to query."

### Threat lookup

Enter a domain, IP, or host. Returns matching threat-intel entities plus a dossier for the entity.

**Block domain** adds the looked-up domain to your blocking policy — a real change to your tenant. It needs a dashboard token (set it under ⋯ Settings) and can be undone with **Unblock** in the same place.

## Build a chart

**Read-only.** Make a chart by picking from menus, with no typing and no AI.

Pick **What to count** (DNS queries, Security hits, DNS queries per second, or DHCP lease changes), what to **Split by**, **When**, **Over time**, and **How many**. Only choices that work together are listed:

- DNS queries split by device, record type, domain or answer (answered, no such name, server failed). Security hits split by what happened, threat type, policy or severity; hits Infoblox gave no severity show as **Not graded**. DHCP lease changes split by what changed. These are changes the lease log recorded, not the leases held now.
- By hour comes with Today or the last 24 hours, and By day with the last 7 or 30 days.
- Security hits are kept by Infoblox one day at a time, so they are never offered by hour or over the last 24 hours.
- Only blocked vs allowed can be split and shown over time together. Every other split is a top 5, 10 or 25.

Pick **No, one total** under Over time to show the count as one large number. Names too long to fit under a bar, such as domains, turn the bars sideways so each name has a row of its own.

The chart type follows from the picks. The sentence above the chart says what it shows. The app builds the query from a fixed list, sends it to your Infoblox account and draws what comes back. **How this chart was made** lists the picks in short lines; open **The query as sent** to see the query word for word and the first rows Infoblox returned, so every number can be checked. **Download as CSV** saves every row Infoblox sent back as a spreadsheet file.

**Add to a page** puts the chart on Overview, DNS, Security, Network or Infra under a name you choose. It becomes an ordinary panel there: Arrange panels moves or hides it, and **Remove from this page** in its About (ⓘ) takes it off. Only the picks are saved, so the chart is redrawn from your Infoblox account each time the page opens, and from whichever account is active. Saved charts are kept on this machine, with the panel layouts, and every account sees the same ones.

**Show cube names** swaps the plain names for the real cube and field names, for anyone who wants to copy them. The setting is kept in this browser.

If Infoblox does not answer, the chart says so in red. That is different from "no activity", which means it answered and there was nothing to count.

## How each panel is built

Every panel's About (ⓘ) ends with a line saying where its numbers come from and whether Build a chart can redraw it. The same facts, for every panel:

- **Yes** means Build a chart draws the same chart from the same Infoblox records.
- **As a copy** means it draws the chart, but not something the panel adds on top, such as a headline figure.
- **No** means the panel is not built from the activity records Build a chart reads, or the app works something out that a chart of raw counts can't show.

<!-- panel-sources:start -->
| Page | Panel | Built from | Can Build a chart redraw it? | Why not |
|---|---|---|---|---|
| Overview | DNS Query Rate — 24h | Infoblox's DNS server metrics | As a copy | the latest-hour figure and the comparison beside it are worked out in the app |
| Overview | Top Consumers | the subnet list | No | it ranks subnets by addresses in use, worked out in the app |
| Overview | Subnet Heatmap | the subnet list | No | how full each subnet is, and its colour band, is worked out in the app |
| Overview | Host Status | the host list | No | the hosts are counted by status in the app |
| Overview | Services and incidents | the service list and the app's incident checks | No | the incidents are worked out in the app |
| Overview | Top Subnets by Utilization | the subnet list | No | how full each subnet is, and its colour band, is worked out in the app |
| Overview | License Inventory | the licence list and account alerts | No | it is a list, not a chart |
| Daily | Open Issues | the subnet, host and zone lists | No | the issues are worked out in the app |
| Daily | Security Today | a sample of the last hour's DNS security events | No | it reads a sample of the last hour's events, not a full count |
| Daily | Top Capacity Risks | the subnet list | No | how full each subnet is, and its colour band, is worked out in the app |
| Daily | Hosts Needing Attention | the host list | No | it is a list, not a chart |
| Daily | DNS Zone Issues | the DNS zone list | No | the zone problems are worked out in the app |
| Network | Utilization Distribution | the subnet list | No | how full each subnet is, and its colour band, is worked out in the app |
| Network | IPAM Spaces — Top Used | the IP space tree | No | it ranks spaces by addresses used, worked out in the app |
| Network | DHCP Leases | the DHCP lease list | No | it is a searchable list, not a chart |
| Network | Which Subnets Run Out First? | the subnet list | No | how full each subnet is, and its colour band, is worked out in the app |
| DNS | DNS Query Rate — 24h | Infoblox's DNS server metrics | As a copy | the latest-hour figure and the comparison beside it are worked out in the app |
| DNS | Zone Counts | the DNS zone list | No | the counts and zone checks are worked out in the app |
| DNS | DNS Services | the DNS service list | No | it is a list, not a chart |
| DNS | Query Volume — 7d | Infoblox's DNS activity records | Yes |  |
| DNS | DNS Zones | the DNS zone list | No | it is a list, not a chart |
| DNS | DNSSEC Health | the DNS zone list | No | the signing checks are worked out in the app |
| DNS | RPZ Policy Zones | the response policy zone list | No | it is a list, not a chart |
| DNS | DTC Load-Balanced Names | the load-balanced name list | No | it is a list, not a chart |
| Security | Threat Events — by Severity | a sample of the last hour's DNS security events | No | it reads a sample of the last hour's events, not a full count |
| Security | Response Summary | a sample of the last hour's DNS security events | No | it reads a sample of the last hour's events, not a full count |
| Security | Triage Inbox | a sample of the last hour's DNS security events | No | it is a list to work through, not a chart |
| Security | Security Inventory | the security policy, feed and service lists | No | it counts several lists in the app |
| Security | Lookalike Domains | Infoblox's lookalike domain service | No | it is a list, not a chart |
| Security | Axur Supplier Risk | Axur's supplier risk service | No | it comes from Axur, not Infoblox |
| Security | CTEM Exposure | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Threat Feed Activity | Infoblox's security hit records | As a copy | the blocked and allowed totals above the bars are worked out in the app |
| Security | SOC Insights | Infoblox's SOC insights | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Asset Insights | Infoblox's asset insight records | No | it counts asset records, which Build a chart does not read yet |
| Security | Exposures | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Asset Risk | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Exposed Surface | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | CTEM Assets | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Infra | Host Inventory | the host list | No | it is a list, not a chart |
| Infra | Host Status | the host list | No | the hosts are counted by status in the app |
| Infra | Service Health | the service list | No | each group's health is rolled up in the app |
| Infra | Host Health | the host list | No | it is a list, not a chart |
| Infra | On-Prem Hosts | the on-prem host list | No | it is a list, not a chart |
| Infra | Asset Discovery | Infoblox's asset discovery records | No | it counts asset records, which Build a chart does not read yet |
| Infra | Jobs | the job list | No | it is a list, not a chart |
| Infra | DFP Services | the DNS forwarding proxy list | No | it is a list, not a chart |
| Assets | Asset Inventory | Infoblox's asset records | No | it is the search and filter controls, with a total and a count for each type |
| Assets | Assets | Infoblox's asset records | No | it is a searchable, paged table, not a chart |
| Assets | Asset detail | Infoblox's asset records | No | it shows one asset's details, not a chart |
| Incidents | Categories | the app's incident checks over the Infoblox API | No | the incidents are worked out in the app |
| Incidents | Severity Counts | the app's incident checks over the Infoblox API | No | the incidents are worked out in the app |
| Incidents | Triage | the app's incident checks over the Infoblox API | No | the incidents are worked out in the app |
| Incidents | SOC Queue | Infoblox IQ actions | No | it is a list of actions to work through, not a chart |
| Incidents | Action Volume | Infoblox IQ actions | No | the actions are counted by day in the app, not read from activity records |
| Audit | Activity Summary | this app's own audit log | No | it is this app's own record, not Infoblox's |
| Audit | Audit Log | this app's own audit log | No | it is a list, not a chart |
| Audit | CSP Portal Audit | the Infoblox audit log | No | it is a list, not a chart |
| Changes | Notability | the Infoblox audit log | No | how notable each change is, is worked out in the app |
| Changes | Changed objects | the Infoblox audit log | No | it is a list, not a chart |
| Provision | Subnet: Request | the Infoblox API | No | it is a form, not a chart |
| Provision | Subnet: Live log | the Infoblox API | No | it is a live log, not a chart |
| Provision | Subnet: Result | the Infoblox API | No | it reports what a change did, not a chart |
| Provision | Full site: Request | the Infoblox API | No | it is a form, not a chart |
| Provision | Full site: Live log | the Infoblox API | No | it is a live log, not a chart |
| Provision | Full site: DHCP ranges not created | the Infoblox API | No | it reports what a change did, not a chart |
| Provision | Full site: Result | the Infoblox API | No | it reports what a change did, not a chart |
| Provision | Full site: Tear down this site | the Infoblox API | No | it is a form, not a chart |
| Provision | Full site: Teardown log | the Infoblox API | No | it is a live log, not a chart |
| Provision | Full site: Teardown result | the Infoblox API | No | it reports what a change did, not a chart |
| Provision | Seed demo: Request | the Infoblox API | No | it is a form, not a chart |
| Provision | Seed demo: Progress | the Infoblox API | No | it is a live log, not a chart |
| Provision | Seed demo: Log | the Infoblox API | No | it is a live log, not a chart |
| Provision | Seed demo: Summary | the Infoblox API | No | it reports what a change did, not a chart |
| Provision | Seed demo: Tear down demo | the Infoblox API | No | it is a form, not a chart |
| Provision | Seed demo: Teardown progress | the Infoblox API | No | it is a live log, not a chart |
| Provision | Seed demo: Teardown log | the Infoblox API | No | it is a live log, not a chart |
| Provision | Seed demo: Teardown summary | the Infoblox API | No | it reports what a change did, not a chart |
| Self-Service | Allocate Address | the Infoblox API | No | it is a form, not a chart |
| Self-Service | Create DNS Record | the Infoblox API | No | it is a form, not a chart |
| Self-Service | Manage Records | the Infoblox API | No | it is a form, not a chart |
| Self-Service | Manage Addresses | the Infoblox API | No | it is a form, not a chart |
| Editor | Create or edit an object | the Infoblox API | No | it is a form, not a chart |
| Drift | Check drift | your templates and the Infoblox API | No | it is a form, not a chart |
| Drift | Error | your templates and the Infoblox API | No | it reports what a change did, not a chart |
| Drift | Result | your templates and the Infoblox API | No | it compares your templates with what is there, worked out in the app |
| AI | Ask AI | the AI model, reading the Infoblox API | No | the AI writes the answer, and Build a chart uses no AI |
| AI | Threat lookup | Infoblox's threat intelligence | No | it looks up one name at a time, not a chart |
| Build a chart | Choose | your picks | No | it is Build a chart's own menu |
| Build a chart | Your chart | Infoblox's activity records, as your picks ask | No | it is Build a chart itself |
| Build a chart | How this chart was made | Infoblox's activity records, as your picks ask | No | it is Build a chart itself |
<!-- panel-sources:end -->

---

## Security posture

The five Provision/teardown streams (`#provision`'s subnet/site/seed runs and their teardowns) are `EventSource` GET requests, because a browser's `EventSource` can't send a mutating verb or custom headers — but a GET is also what a hostile page could fire blind. Those five routes carry a stricter gate than the rest of the write surface: a request must carry `Sec-Fetch-Site: same-origin` (or `none`) or a matching Origin/Referer. A bare loopback request with no fetch-metadata at all is refused, where the ordinary write endpoints still trust it. Setting `DASHBOARD_TOKEN` sidesteps this check entirely — since `EventSource` can't set the `X-Auth-Token` header, the dashboard instead passes the token on the stream URL as `?token=`.

Separately, the server checks the `Host` header on every request against an allowlist (`localhost`, `127.0.0.1`, `[::1]`, and whatever it's bound to); an unrecognized `Host` gets `421 Misdirected Request`, which stops DNS-rebinding attacks. A wildcard bind (`HOST=0.0.0.0`, the Docker default) can't know its own hostname, so that check stands down until you set `ALLOWED_HOSTS`. Full variable reference and the rest of the deployment security notes are in [docs/DEPLOYMENT.md](DEPLOYMENT.md#security-notes) — this section only points at what exists, not how to configure it.
