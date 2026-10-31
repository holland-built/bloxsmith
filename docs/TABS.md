# Dashboard tabs

What each tab in Bloxsmith does, what it reads, and what it can change.

Tabs fall into two groups:

- **Read-only**: Overview, Daily, Network, DNS, Security, Infra, Assets, Incidents, Audit, Changes. They refresh on a timer and only show data. They never write to Infoblox. Assets is the exception to the timer: it reads again only when you ask, for the reason given in its own section.
- **Can make changes**: Provision, Self-Service, Editor and Demo server. These create, change or delete real objects in your tenant. Drift and AI sit in between. Drift only reads. AI reads, and has one action that writes: blocking a domain.

Almost every panel follows one rule: a feed that failed to load never looks like a feed that loaded and came back empty. When a request fails, times out, or returns something the panel can't trust, the panel says so. You see "feed unavailable", a warning, or a line naming the error, never the blank state of a healthy, empty tenant. So a panel with no rows means there are no rows.

## The write flow

Every page that writes to Infoblox uses the same two buttons, in the same order:

1. **Preview** sends the request to the server marked as a trial run. Nothing is written. The server checks it and shows you exactly what it would do.
2. **Apply** appears only after a preview that worked, and makes the change. The button is named for the job: Create, Allocate, Provision, Tear down.

The flow enforces three rules, so you don't have to remember them:

- **A preview always goes to the server.** It is a real request, so it catches mistakes your browser can't see, such as a badly formed MX record, a TTL that isn't a whole number, or a missing field.
- **Apply only follows a fresh preview.** You can't write anything without seeing the plan first.
- **Changing any field after a preview hides Apply** and shows "inputs changed — preview again". The plan on screen is dimmed, because it describes what you had typed before, not what is there now.

If a preview looks wrong, it is wrong. Fix the input and preview again.

One limit: Provision streams its plan from the server, and the server plans again when you press Apply. Provision promises that your inputs are the same between preview and apply, not that the plan is byte for byte the same. Self-Service and Editor send exactly the request you reviewed.

Actions that delete things have extra safeguards. Teardown needs an admin token and a typed confirmation. Editor's Delete is a separate button you click twice, and it never goes through preview.

If the tenant you are using is read-only, the buttons that would write are greyed out and the panel says why. Preview still works on Self-Service and Editor.

| Tab | Writes? | Purpose |
|---|---|---|
| [Overview](#overview) | no | Your network at a glance |
| [Daily](#daily) | no | What needs attention today |
| [Network](#network) | no | IP addresses and DHCP in detail |
| [DNS](#dns) | no | Query rate, services, DNSSEC, RPZ, DTC |
| [Security](#security) | no | Threats, exposures, lookalike domains |
| [Infra](#infra) | no | Host and service health |
| [Assets](#assets) | no | Every device Infoblox has found, searchable, a page at a time |
| [Incidents](#incidents) | no | The SOC queue |
| [Audit](#audit) | no | Who changed what |
| [Changes](#changes) | no | What changed in the last 24 hours |
| [Provision](#provision) | **yes** | Build subnets, sites and demo networks |
| [Self-Service](#self-service) | **yes** | Take an address, add a DNS record, edit or remove either |
| [Editor](#editor) | **yes** | Create, update or delete one object directly |
| [Drift](#drift) | no | Your template compared with what is really there |
| [Demo server](#demo-server) | **yes** | Build a NIOS-X server on Proxmox for a demo, then remove it |
| [AI](#ai) | one action | Ask questions, look up threats |
| [Build a chart](#build-a-chart) | no | Make a DNS or security chart by picking from menus |

## Rearranging panels

You can rearrange every tab, and each tab remembers its own layout. Moving a panel on Network changes nothing on DNS. Provision keeps three layouts, one each for Subnet, Full site and Seed demo, because those are three different pages behind one tab.

- **Move**: open the ⋯ menu in a panel's header and drag **Move**. Press Escape while dragging to cancel. Without a mouse, Tab to ⋯ and press Enter, Tab to **Move** and press Enter, move with ← and →, then press Enter to keep the new place or Escape to put it back.
- **Resize**: drag a panel's right edge. Press Escape while dragging to keep the old width. When moving with the keyboard, ↑ and ↓ resize.
- **Take a panel off the page**: **Take off the page**, in the same ⋯ menu. Nothing is deleted and no data is lost. The tab just stops showing the panel until you put it back.
- **Arrange panels**: a button above the panels opens a window called "Arrange this page". It lists what is on the page, in the order you see it, and lists separately anything you took off. Drag a row up or down, or use its **Move up** and **Move down** buttons. **Take off the page** and **Put back on the page** hide a panel and bring it back. A panel you put back goes to the *end* of the page, not where it was before, and the window says so. The window also explains all of this in words, for anyone who hasn't used a ⠿ grip before.
- **Saving**: there is no Save button. Every move, resize and hide is saved as soon as you let go, the page tells you it saved, and the layout is still there on your next visit and after a server restart.

Two tabs have fewer controls on purpose. **Editor** has one panel and always will. **Drift** has one until you run a check, and a second one appears with the result. A single panel has nowhere to move, so those tabs show no ⠿ handle and no **Arrange panels** button until a second panel appears. A control that can't do anything would only mislead. Resize and ✕ still work on a single panel, and if you take that panel off the page, the **Arrange panels** button appears so you can bring it straight back.

On wide screens, Provision, Self-Service, Editor and Drift also have an **On this page** list on the left. It names every panel on the page, and clicking a name jumps to that panel. The panel you are looking at is marked. The list keeps up as the page changes, for example when you switch Provision between Subnet, Full site and Seed demo.

You can't add or delete panels. Each tab has a fixed set that comes with the app, and **Take off the page** only hides one. If a panel is missing and you didn't hide it, the service behind it wasn't found on this tenant. The tab says so, in a row that offers to show the panel anyway.

---

## Moving around

The app opens on **Overview**. The everyday jobs, **Overview**, **Get an address**, **Daily report** and **Charts**, sit down the left side. On a phone they are a bar along the bottom. Every other page is under **All pages** at the top left.

The box at the top takes two kinds of input:

- **Something to look up**: an IP address, a subnet like `10.0.0.0/24`, or a host name. Press Enter to see what Infoblox knows about it.
- **A question**: anything else. Enter opens the AI with your question filled in. Nothing is sent until you press Ask there.

Asking for an address ("give me an address in Dublin") opens Get an address, and asking for a chart opens Build a chart. Before you press Enter, the box tells you where Enter will take you. Cmd+K (Ctrl+K on Windows) opens the same search from anywhere.

## Overview

Your network at a glance, and the page the app opens on. Refreshes every 30 seconds.

- **Needs a look**: a short list above the graphs of what needs attention, worst first. It covers hosts that are not online, critical and high security events, and the incidents Infoblox reports, one row per kind. Each row's text is a link to the page where you fix it, and **Ask why** opens the AI with a question about it. If a feed can't be read, the list says which one, so an empty list always means nothing was found.
- **Headline numbers**: a row of tiles across the top. They show DNS queries per second, hosts, hosts not online, subnets at 90% or more, active leases, and critical or high security events. A tile that counts something bad turns red or amber when there is any, and stays plain when there is none. A count that couldn't be read shows a dash with no colour and the word "unavailable". Click a tile to jump to its panel, or to the tab with the detail.
- **DNS Query Rate — 24h**: the average queries-per-second trend, with the change since the first hour shown.
- **Top Consumers**: the 12 subnets with the most addresses *in use*. They are ranked by count, not percentage, because a list of tiny /32 links at 100% tells you nothing.
- **Subnet Heatmap**: how full each subnet is, worst first, up to 288 squares. Small /29 to /32 links are left out.
- **Host Status**: how many hosts are active, degraded or offline, with the ones that are not active named underneath, worst first.
- **Services and incidents**: each Infoblox service with how many of its machines are online, then the open incidents, worst first, with links to the Incidents and Infra tabs. A feed that is down says so instead of showing an empty list.
- **Top Subnets by Utilization**: a table you can sort, filter and save as CSV.
- **License Inventory**: each licence's SKU, state, expiry date and time left. Under 30 days is red, under 90 is amber.

If a count could only be read for part of the network, the panel says "loaded rows", so it doesn't look like it covers everything.

## Daily

The morning check. Also refreshes every 30 seconds.

- **Open Issues**: one count of the things waiting for a decision.
- **Security Today**: threat events from the last hour, up to 50.
- **Top Capacity Risks**: the 10 subnets with the least free space, small links left out.
- **Hosts Needing Attention**: every host that isn't healthy.
- **DNS Zone Issues**: zones with a setup problem.

## Network

IP addresses and DHCP in detail.

- **Utilization Distribution**: how many subnets fall in each fullness band.
- **IPAM Spaces — Top Used**: addresses used in each IP space.
- **DHCP Leases**: a lease table you can filter.
- **Subnet table**: the full list, without /29 to /32 links.

You can link straight to a view: `#network?subnet=10.0.0.0`, `#network?minUtil=90`, `#network?focus=leases`.

## DNS

Everything about DNS. Refreshes every 30 seconds.

- **DNS Query Rate — 24h** and **Query Volume — 7d**.
- **DNS Services**: each DNS service and its state.
- **DNSSEC Health**: which zones are signed.
- **RPZ Policy Zones**: how many response policy zones there are, and their state.
- **DTC Load-Balanced Names**: names that DNS Traffic Control shares out across servers.

## Security

Threats and exposures. This tab reads several Infoblox feeds, so its panels can load at different speeds. The Triage Inbox comes first, because that is where you act.

- **Triage Inbox**: events waiting for you.
- **Threat Events — by Severity** and **Threat Feed Activity**.
- **Lookalike Domains**: domains pretending to be yours. Set your own domain from the header.
- **Axur Supplier Risk**: problems Axur found at your suppliers, worst first, one row per supplier.
- **CTEM Exposure**, **Exposures**, **Exposed Surface**, **CTEM Assets**: what of yours can be reached from the internet.
- **Asset Insights** and **Asset Risk**.
- **SOC Insights**.

An empty panel means the feed returned nothing. It doesn't mean you are safe. Check the panel's note.

### Axur, in four points

Axur is a separate company from Infoblox, with its own subscription and its own key.

- **Where the key goes.** Paste it under ⋯ Settings, where it is encrypted with your Infoblox keys. Setting `AXUR_API_KEY` also works, for setups that never open a vault. If both are set, the saved key wins. The key belongs to this installation, so switching Infoblox accounts doesn't change it.
- **What the order means.** Suppliers are sorted by credentials exposed, the only figure that compares fairly between them. Axur's other measures count different things, so the biggest number isn't always the worst problem.
- **What "Types affected" means.** How many kinds of problem a supplier has, not how many problems. It sits beside the ranking but doesn't change it.
- **When there is no number.** A dash means nothing was counted, and the panel says why: no key, a locked vault, an account code it couldn't work out, or a failed read. An empty list says "no suppliers monitored in Axur", which is not the same as "no problems found".

## Infra

Host and service health. Host health refreshes every 15 seconds, the rest every 30 to 60.

- **Host Health**, **On-Prem Hosts**, **Host Status**.
- **Jobs**: recent job runs.
- **DFP Services**: the state of each DNS forwarding proxy.
- **Asset Discovery**: how discovery runs are going.

You can link straight to a view: `#infra?status=offline`.

## Assets

The list behind the counts. Infra's **Asset Discovery** tile and Security's **Asset Insights** tile tell you how many assets there are. This tab tells you which ones.

- **Asset Inventory**: the total, and a chip for each asset type with its count. Click a chip to show only that type, and click it again to clear it. The chips are only the types *your tenant has*, so a chip never filters down to nothing.
- **Assets**: the list itself, with name, type, provider, vendor and last seen. Sort on any of the five columns. 50 rows to a page.
- **Row detail**: click a row to see the fields that are too often empty for their own column: OS, IP addresses, MAC addresses, model and location. Only about a quarter of assets have an OS recorded, so a column for it would be mostly blank, but on the asset you picked it is often the first thing you want.

Search looks at the asset **name** and ignores upper and lower case. It searches every asset on the server, not just the page on screen. Searching from page 4 of 48 searches all 48 pages and takes you to page 1 of the results.

The server does the searching, filtering, sorting and paging. Your browser is never sent 2,000 or more assets just to show you 50.

**This tab doesn't refresh on a timer, on purpose.** The other read-only tabs refresh themselves because what they watch changes minute to minute. The asset list only changes when a discovery sync runs, so a timer would fetch the same rows again and again. It would also move the table while you were halfway down page 4, which is the one time a table must stay still. Press **Refresh** to ask the server to read the list again. The server keeps its own short cache, so two refreshes close together can return the same rows.

A panel that says **unavailable** couldn't be read, and it names the reason. A list that is really empty says so in different words. The two never look the same, so an empty table here means your filter matched nothing. The total works the same way: if the count fails but the list loads, the total shows as unavailable, because a wrong total is worse than none.

## Incidents

The SOC queue. Refreshes every 20 seconds.

- **Categories**: click a category to show only its incidents in the list.
- **Triage**: the incident list. Click a row for the detail.
- **Severity Counts**: how many of the loaded incidents are critical, high, medium and low.
- **SOC Queue**: Infoblox IQ Actions, with the detail of each one.
- **Action Volume**: actions per day.

## Audit

Who changed what. The Audit Log comes first, with the Activity Summary beside it on wide screens.

- **Audit Log**: actions taken *through Bloxsmith*, from this app's own log. Each entry carries a hash of the one before it and an HMAC signature made with a key kept outside the log's folder, and a separately sealed count says how many entries there should be. The panel shows the result of checking all this. It says the log is intact, or tampered with (naming the entry where it broke **and why**: a forged entry, missing entries at the end, or a changed seal), or that it could not be verified (**with the reason**: a file that can't be read, or a key this copy of the app doesn't have). A check that fails to run says "could not be verified", never "intact", because a broken check must not look like a clean result. A lost or replaced key also gives "could not be verified", never "tampered". The log may be fine, the app just can't check it, and saying otherwise would accuse someone with no evidence. What the key does and doesn't protect against is in [DEPLOYMENT.md](DEPLOYMENT.md#the-audit-chains-key). The panel loads the newest 2,000 entries. If the log is longer, a line says how many are shown, and **Load older** fetches the ones before. The filter box only searches what has loaded.
- **Activity Summary**: recent event counts.
- **CSP Portal Audit**: activity in the Infoblox Portal itself, from the Portal's audit log. Changes made outside Bloxsmith show up here, not in the Bloxsmith log. It loads the latest activity as soon as you open the tab, and the search box filters that list. You don't have to search before anything appears.

There are two logs on purpose: one records what this app did, the other what everything else did.

---

## Changes

What changed in the Portal in the last 24 hours. It reads the same Portal audit log as the Audit tab's Portal panel, limited to one day and grouped by what was changed.

- **Notability**: four questions about the day: anything deleted, any failed changes, changes made out of hours, and anyone new making changes. Each question gets an answer, None, or Unknown when the data can't tell. Someone counts as new if they made changes in the later half of the 24 hours and none in the earlier half. There is no history before that to check.
- **Changed objects**: the changes grouped by the object they touched, newest group first. Deletions and failures are red.

It shows at most the 500 latest events from the last 24 hours. The Portal returns no more than that in one request, so on a busy day the oldest changes are left out, and the page says so when that happens.

---

## Provision

**Writes to Infoblox.** Builds real objects. Uses the [Preview and Apply flow](#the-write-flow), and shows progress line by line as the plan runs.

Your role is shown at the top right (`VIEWER`, `OPERATOR` or `ADMIN`). Live teardown needs admin.

### Subnet

Make one subnet inside an address block you already have.

1. Pick an **IP space**, then a **block** inside it.
2. Set the **Size** (the prefix, such as `24` for 256 addresses), a **name**, and a comment if you want one.
3. Tick **Create matching DNS zone** if you want one.
4. Press **Preview** to see the plan without writing anything. Then press **Provision**.

When it works you get the new subnet's ID and address.

### Full site

Build a whole site from a template in your template library in one run: address block, DNS zone, subnets, DHCP ranges and hosts.

1. Pick a **template**. You can choose a different **IP space** from the one the template uses.
2. Press **Preview**, read the plan, then press **Provision site**.
3. If the site already exists, the run says *skipped* and why, instead of making a second copy.

**Tear down this site** deletes what that template built, for good. Preview it first like anything else. The live run needs admin and the site name typed in to confirm.

If the template list is empty, no templates are installed. Run `scripts/fetch_templates.py`, or use the release download or container image, which include them.

### Seed demo

Builds a full demo network in the regions you tick (AMER, EMEA, APAC) from the template library, all at once. Made for demos and lab tenants.

Progress for each template adds up as `done/total`, and each failure is listed. The last message says what happened, not just that the run ended. A clean run says "Seed complete". A mixed one says "Seed partial — *X* of *N* succeeded, *Y* failed". A run where nothing worked says "Seed failed — 0 of *N* template(s) succeeded".

**Tear down demo** deletes every object the seed made in the chosen space. The live run needs admin and `DELETE` typed in to confirm.

> Do not point Seed demo at a production tenant. It writes many objects quickly, and teardown is the only way back.

## Self-Service

**Writes to Infoblox.** Two short forms for everyday requests, so people don't need the full Editor, and two panels for changing what already exists. The forms use the [Preview and Apply flow](#the-write-flow). Manage Records and Manage Addresses have a simpler edit and delete flow, described below.

### Allocate Address

Take the next free address, or several, from a subnet.

1. Pick **IP space**, then **block** (optional), then **subnet**.
2. Set how many addresses you want, and a name if you want one.
3. **Preview** shows which addresses it would take. **Allocate** takes them.

### Create DNS Record

Add a record to a zone you already have.

1. Pick the **zone** and record **type** (A, AAAA, CNAME, MX, TXT, SRV, PTR, NS, CAA).
2. Fill in the **name** (`@` for the zone itself), the **value**, and a TTL if you want one.
3. **Preview** sends it to the server to check and shows the record it would write. **Create** writes it.

The preview shows the record the way the *server* read it, which is often not how you typed it. For example, an SRV value of `10 5 5060 sip.example.com` comes back split into priority, weight, port and target. It is worth a look.

### Manage Records

Edit or delete a record that is already in a zone.

Pick a **zone**, then press **Edit** on any row you can change. Record types that can't be changed are marked, and have no Edit or Delete. Change the value, TTL or comment and press **Preview**, which checks it on the server just like the create form. **Update** reads the record again just before writing and compares it with the copy the preview used. If they differ, Update stops with "record changed since you previewed — preview again", so it never overwrites a change someone else made.

**Delete** takes two clicks. The first click changes the button to "Click again to delete `<type> <name> -> <value>`", naming the exact record. If you don't click again within four seconds, it goes back to normal.

### Manage Addresses

Give an address back so it can be used again.

Pick an **IP space**, then a **subnet**, to list its addresses. **Release** works like Delete in Manage Records. One click shows "Click again to release `<address>`", the second click releases it, and after four seconds it goes back to normal.

## Editor

**Writes to Infoblox.** Create, update and delete single objects directly. It is the blunt tool, so use Provision or Self-Service when they can do the job.

It handles six object types: DNS Zone, Subnet, Address Block, DHCP Range, Host, and Tags (set the site tags on an address block).

**The box at the top, ID of an existing one, decides what the form does:**

- Leave it blank and the form **creates** a new object.
- Paste in an object's ID and the form **updates** that object, and a Delete button appears.

**Then:** press **Preview** to see the exact request it will send. If it is right, press **Create** (or **Update**). See [the write flow](#the-write-flow).

**Delete** is separate and doesn't go through preview. It takes two clicks: the first changes the button to "Click again to permanently delete", and it goes back to normal after four seconds. Delete can't be undone.

Other tabs can open Editor with the form filled in, using a link such as `#editor?type=subnet&id=abc123`.

> Subnets and address blocks made here belong to no site template, so Drift will list them as extra.

## Drift

**Read-only.** Compares a site template with what is really in Infoblox.

1. Pick a **template**. You can choose a different **IP space** from the one the template uses.
2. Press **Check drift**.

The result is either `✓ in-sync` or a count of differences, grouped by kind, worst first. Each difference is marked:

- **missing**: the template has it and Infoblox doesn't.
- **changed**: it exists, but a value is different from the template.
- **extra**: it is in Infoblox but not in the template.

Drift never fixes anything. To close a gap, provision the site again (missing), or edit or delete the object (changed, extra).

## Demo server

**Writes, after a preview.** Builds a NIOS-X server on Proxmox and shows each Infoblox step as code. Made for showing a customer what automation looks like from start to finish, usually in about five minutes once the NIOS-X image is on Proxmox.

Before the first run, Proxmox needs a private bridge for the demo network, and this computer needs OpenTofu and an SSH key for Proxmox. The Docker version of Bloxsmith can't run the demo. The [README's Demo server section](../README.md#demo-server) has the setup, step by step.

1. Fill in **Settings** once: the Proxmox login, a demo bridge and network on it, the NIOS-X image (only needed on this computer if Proxmox doesn't have it yet), and a join token. The token is kept in the vault and never shown again.
2. Press **Preview**. It checks the settings, the API key, OpenTofu (or Terraform), the image, SSH to Proxmox and the bridge, and shows the code. Nothing is created.
3. Press **Build it**. The steps run in order. It makes sure the demo network exists, reserves the next free address, builds the VM, and waits for it to join the Portal. Then it starts DNS on it with a name server group and a demo zone, and looks up a name from the Proxmox host to prove it answers.

Every run gets an ID like `c-20261030-150000`. The ID is tagged on the address, DNS service, name server group, zone and records the run made. It is also written into the VM's description and kept in a run record in the app's state folder.

**Tear down** lists what it would remove first, and removes nothing until you confirm. Before deleting each item it checks that the item still belongs to the run: the VM's name, bridge, seed disk and description, and that the Portal host is still at the run's address. Anything that fails a check is left alone and named. The demo network stays for the next run.

## AI

**Reads, plus one action that writes.** Two separate panels, side by side on wide screens: Ask AI on the left and Threat lookup beside it. On a phone one sits above the other.

### Ask AI

Ask questions about your own data in plain words, such as "which subnets are nearly full?" or "what changed in the last 24 hours?". Suggested questions take one click.

Each answer is marked **AI-generated** and lists the lookups the AI made underneath, so you can check where a number came from. It needs a key for an AI model that can use tools. See the AI query box section in the [README](../README.md). Without one, this panel shows an error and the rest of the dashboard still works.

If the vault is locked, questions get "Vault locked — unlock to query."

### Threat lookup

Enter a domain, IP address or host. It returns the matching threat records and a summary page for what you looked up.

**Block domain** adds the domain you looked up to your blocking policy, which is a real change to your tenant. It needs a dashboard token (set it under ⋯ Settings), and **Unblock** in the same place undoes it.

## Build a chart

**Read-only.** Make a chart by picking from menus. No typing, no AI.

Pick **What to count** (DNS queries, Security hits, DNS queries per second, DHCP lease changes, Assets, or New assets still held), what to **Split by**, **When**, **Over time**, and **How many**. Only choices that work together are listed:

- DNS queries can be split by device, record type, domain or answer (answered, no such name, server failed). Security hits can be split by what happened, threat type, policy or severity. Hits that Infoblox gave no severity show as **Not graded**. DHCP lease changes can be split by what changed. These are the changes the lease log recorded, not the leases held now.
- **Assets** counts every asset Infoblox holds now, so its only time choice is **Latest inventory**. Split it by asset type, category, operating system, what found it, cloud or on-premises, vendor or region. **Problem** (noncompliant, unregistered, zombie, lifecycle) and **Missing record** (DNS name, reverse DNS, IPAM) count each one separately, so an asset with two problems is in both bars.
- **New assets still held** counts assets by when Infoblox first saw them. An asset that has since been removed isn't counted.
- By hour goes with Today or the last 24 hours. By day goes with the last 7 or 30 days or a calendar month. By week goes with the last 30 or 90 days. DNS queries per second has no By week.
- How far back a chart can go depends on how long your account keeps the data.
- Infoblox stores security hits one day at a time, so they are never offered by hour or over the last 24 hours.
- Only blocked against allowed can be split and shown over time together. Every other split is a top 5, 10 or 25.

Pick **No, one total** under Over time to show the count as one large number. When names are too long to fit under a bar, such as domains, the bars turn sideways so each name gets its own row.

**Start from a question** sets every menu at once for a ready-made chart, such as *Which kinds of asset have no DNS name?* or *Which policies blocked the most this week?* Most come from the tested questions in the [UAI Query Library](https://github.com/IngmarVG-IB/infoblox-uai-query-library). You can change any menu afterwards.

**Only show** narrows the chart to one value of another field. Pick the field, then *is* or *is not*, then one of the values Infoblox has for it (the 50 most common). For Problem and Missing record it reads *includes* or *does not include*. If you change what you count or split by, a filter that no longer fits is dropped.

The picks decide the chart type, and the sentence above the chart says what it shows. The app builds the query from a fixed list, sends it to your Infoblox account and draws what comes back. **How this chart was made** lists the picks in short lines. Open **The query as sent** to see the exact query and the first rows Infoblox returned, so you can check every number. **Download as CSV** saves every row Infoblox sent back as a spreadsheet file.

**Open these assets in Infoblox** appears under an asset chart. It opens the Asset Inventory in the Infoblox Portal in a new tab with the same filter filled in. Press **Apply** there. Click a bar, or open **Open one of the bars**, to see only that bar's assets. The Portal opens on whichever account your browser used last, so switch it to the same account as this app or the counts won't match. Bars for a blank value ("Not reported"), and splits the Portal can't filter on (Category, Region), have no link.

**Add to a page** puts the chart on Overview, DNS, Security, Network or Infra under a name you choose. There it becomes a normal panel. Arrange panels moves or hides it, and **Remove from this page** in its About (ⓘ) takes it off. Only the picks are saved, so the chart is drawn again from your Infoblox account each time the page opens, using whichever account is active. Saved charts are stored on this computer with the panel layouts, and every account sees the same ones.

**Show cube names** swaps the plain names for the real cube and field names, for anyone who wants to copy them. This browser remembers the setting.

If Infoblox doesn't answer, the chart says so in red. That is different from "no activity", which means Infoblox answered and there was nothing to count.

## How each panel is built

Every panel's About (ⓘ) ends with a line saying where its numbers come from and whether Build a chart can draw it again. Here are the same facts for every panel:

- **Yes** means Build a chart draws the same chart from the same Infoblox records.
- **As a copy** means it draws the chart, but not something extra the panel adds, such as a headline figure.
- **No** means the panel isn't built from the activity records Build a chart reads, or the app works out something a chart of plain counts can't show.

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
| Security | Asset Insights | Infoblox's asset insight records | No | it counts a different set of asset records from the ones Build a chart reads |
| Security | Exposures | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Asset Risk | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | Exposed Surface | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Security | CTEM Assets | Infoblox's attack surface service | No | it comes from the ordinary Infoblox API, not the activity records Build a chart reads |
| Infra | Host Inventory | the host list | No | it is a list, not a chart |
| Infra | Host Status | the host list | No | the hosts are counted by status in the app |
| Infra | Service Health | the service list | No | each group's health is rolled up in the app |
| Infra | Host Health | the host list | No | it is a list, not a chart |
| Infra | On-Prem Hosts | the on-prem host list | No | it is a list, not a chart |
| Infra | Asset Discovery | Infoblox's asset discovery records | No | it counts a different set of asset records from the ones Build a chart reads |
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
| Demo server | Settings | the app's own vault | No | it is a form, not a chart |
| Demo server | Build | Proxmox and the Infoblox API | No | it is a live log, not a chart |
| Demo server | The Infoblox code | the app's own files | No | it is code, not a chart |
| Demo server | Runs | the app's own run records | No | it is a list, not a chart |
| AI | Ask AI | the AI model, reading the Infoblox API | No | the AI writes the answer, and Build a chart uses no AI |
| AI | Threat lookup | Infoblox's threat intelligence | No | it looks up one name at a time, not a chart |
| Build a chart | Choose | your picks | No | it is Build a chart's own menu |
| Build a chart | Your chart | Infoblox's activity records, as your picks ask | No | it is Build a chart itself |
| Build a chart | How this chart was made | Infoblox's activity records, as your picks ask | No | it is Build a chart itself |
<!-- panel-sources:end -->

---

## Security posture

The five Provision and teardown streams (the subnet, site and seed runs on `#provision`, and their teardowns) are `EventSource` GET requests. A browser's `EventSource` can't send any other method or custom headers, but a GET is also what a hostile web page could send without seeing the answer. So those five routes are checked more strictly than the other write routes. A request must carry `Sec-Fetch-Site: same-origin` (or `none`), or an Origin or Referer that matches. A request from this computer with no fetch headers at all is refused, although the ordinary write routes still accept it. Setting `DASHBOARD_TOKEN` replaces this check. Because `EventSource` can't set the `X-Auth-Token` header, the dashboard passes the token on the stream address as `?token=` instead.

The server also checks the `Host` header of every request against an allowed list (`localhost`, `127.0.0.1`, `[::1]`, and whatever address it listens on). A `Host` it doesn't recognise gets `421 Misdirected Request`, which stops DNS rebinding attacks. When it listens on every address (`HOST=0.0.0.0`, the Docker default) it can't know its own name, so this check is off until you set `ALLOWED_HOSTS`. The full list of settings and the rest of the security notes are in [docs/DEPLOYMENT.md](DEPLOYMENT.md#security-notes). This section only says what exists, not how to set it up.
