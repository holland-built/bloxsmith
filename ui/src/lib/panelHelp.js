// ---------------------------------------------------------------------------
// PANEL_HELP — one plain-English explanation per panel, keyed by `panelId`.
//
// WHY A DICTIONARY AND NOT A PROP. A `help=` prop next to every `<Card` would
// put the copy 95 places, where nobody can read it as a set and nothing can
// check it is complete. Keyed by panelId it has exactly one home, one reader
// (Card's About disclosure), and one enforcement test — panelHelp.test.js scans the
// tabs and fails when a Card exists that this file has never heard of.
//
// The key is `panelId`, which is also what a saved layout refers to. That is
// deliberate: an id is already required to be stable (renaming one silently
// detaches a user's saved arrangement), so help hangs off the one identifier
// nobody is free to reword. A title cannot be the key — 44 Cards compute their
// title at render time and titles repeat across tabs.
//
// ---------------------------------------------------------------------------
// STYLE GUIDE — read this before adding an entry.
//
//   what   Required. One sentence: what this panel is showing. Written for
//          somebody who runs the network but does not build this app.
//          "how full it is", never "utilization percentile".
//          "the machines running Infoblox", never "the grid members".
//
//   look   Optional, and OMITTED unless there is something real to say —
//          a control that exists, a colour that means something, a click that
//          goes somewhere. Never invent an action to make an entry look
//          finished. An entry with a `what` alone is a complete entry.
//
// Rules that apply to both lines:
//   - Plain words. If a sentence needs a glossary, rewrite the sentence.
//   - Do not repeat the Card's own `title` or `note`. The reader can see them;
//     a disclosure that restates the heading has told them nothing.
//   - Say what the numbers cannot say. The panels in this app distinguish
//     "unknown" from "zero" everywhere, and that distinction is invisible until
//     somebody writes it down — so where a panel shows Unknown, say so.
//   - No promises the app cannot keep. There is no add-panel or delete-panel
//     feature; do not describe one.
//   - Length is capped by the test: 160 chars for `what`, 200 for `look`. That
//     is the disclosure's budget, not a target to fill.
//
// The move/resize sentence is NOT written here. Card appends it automatically
// to any panel that is actually rearrangeable, so it can never drift out of
// step with which grids are managed.
// ---------------------------------------------------------------------------

export const PANEL_HELP = {
  // ---- Overview ----
  'dns-hero': {
    what: 'The average number of DNS lookups a second your servers answered, hour by hour across the last 24 hours.',
    look: 'The big figure is the latest hour, and the note beside it compares that hour with the first one on the chart. Click the heading to open the DNS tab.',
  },
  'kpi-stack': {
    what: 'Three live counts: addresses currently leased out, how many subnets you have, and how many of those are at least 90% full.',
    look: 'Click any of the three to open the matching list. The small line under each is every loaded subnet’s fullness, sorted low to high — not a history.',
  },
  'top-consumers': {
    what: 'The twelve subnets handing out the most addresses right now.',
    look: 'Ranked by addresses in use, not by how full they are, so tiny always-full links do not crowd out real capacity problems. Click a bar to open that subnet.',
  },
  'subnet-heatmap': {
    what: 'One square per subnet, coloured by how full it is: blue is fine, amber past 75% full, red past 92%.',
    look: 'Only the fullest few hundred are drawn, worst first. Point at a square, or drag a finger across them, to read its name and figure. Click or tap one to open that subnet.',
  },
  'host-status': {
    what: 'How your Infoblox machines split by state: running, struggling, offline, anything else, or a state nothing reported back.',
    look: 'Click a slice or a label to see just those machines on the Infra tab.',
  },
  'subnet-table': {
    what: 'The subnets that loaded, with how full each one is, how many addresses are still free, and which site it belongs to.',
    look: 'Type in the box to filter, click a column heading to sort, or export the list as a spreadsheet. Click a row to open that subnet. "Unknown" means never measured, not empty.',
  },
  'license-inventory': {
    what: 'Every Infoblox licence on this tenant, what it covers, when it runs out, and how many you hold.',
    look: 'Time Left turns amber under 90 days and red under 30. Sort by that column to see what expires soonest.',
  },

  // ---- Daily ----
  'daily-open-issues': {
    what: 'Three counts: subnets 85% full or more (tiny networks under 16 addresses left out), machines not reporting as online, and DNS zones with a problem recorded.',
    look: 'Click any row to open the list behind it. A row reading "unavailable" in red means that one feed failed — the other two rows are still real.',
  },
  'daily-security-today': {
    what: 'Threat events seen in the last hour, counted by how serious each one was, and how many were stopped rather than only written down.',
    look: 'The count by the title is 50 events at most, so a busy hour is a sample, not a total. A dash there means the threat feed could not be read.',
  },
  'daily-top-capacity-risks': {
    what: 'A big network with only 40 addresses spare is a worse problem than a tiny one sitting at 99% full, so this ranks by addresses left, not by fullness.',
    look: 'Click a row to open that subnet on the Network tab. The small always-full links, anything under 16 addresses, are left out on purpose.',
  },
  'daily-hosts-attention': {
    what: 'Machines whose state is anything other than online or active, including the ones that never reported a state at all.',
    look: 'Click a row to open the Infra tab already narrowed to these. The count in the header shows a dash, not 0, when the machines could not be read.',
  },
  'daily-dns-zone-issues': {
    what: 'DNS zones with at least one configuration problem recorded against them, and what each of those problems is.',
    look: 'The red number is how many problems that zone has. Click a row to open the DNS tab filtered to just these zones.',
  },

  // ---- Network ----
  'network-utilization-distribution': {
    what: 'How many of your subnets are lightly used, filling up, or nearly out of addresses.',
    look: 'Blue is under 70% full, amber 70–85%, red past 85%. A subnet that reports no figure is left out of the bars and counted in the line at the top right.',
  },
  'network-ipam-spaces': {
    what: 'The twelve address spaces handing out the most addresses right now.',
    look: 'Bar length is how full a space is, and its colour follows: amber past 75% full, red past 92%. The number on the right is addresses in use, not the percentage.',
  },
  'network-dhcp-leases': {
    what: 'Every address DHCP has leased out, the machine holding it, its hardware address, and when the lease runs out.',
    look: 'Search by address, name or MAC, or narrow to one lease state; the leases ending furthest away come first. Hidden when no DHCP service is detected.',
  },
  'network-exhaustion': {
    what: 'The twenty subnets closest to running out of addresses, with how full each one is and how many addresses are still free.',
    look: 'Amber past 75% full, red past 92%. A subnet nobody measured gets a grey Unknown badge, no bar and dashes, and sorts to the bottom whichever way you sort.',
  },

  // ---- Dns ----
  'dns-query-rate': {
    what: 'How many lookups a second your DNS servers answered, hour by hour, across the last 24 hours.',
    look: 'The big figure is the latest hour, and the note beside it compares that hour with the first one on the chart. Hidden when no DNS service is found on this tenant.',
  },
  'dns-zone-kpis': {
    what: 'How many DNS zones you hold, how many of them have a problem, and how many are behaving oddly.',
    look: 'A zone that publishes no cache time is never examined, so the small print says how many were skipped. Those zones are unchecked, not clean.',
  },
  'dns-services': {
    what: 'Each DNS service running on this tenant, with any comment written against it and the pool it belongs to.',
    look: 'This panel is hidden when no DNS service is detected; a dashed row takes its place and offers to show it anyway.',
  },
  'dns-query-volume-7d': {
    what: 'The total number of lookups your DNS servers answered on each of the last seven days.',
    look: 'When this feed cannot be read the heading says "feed unavailable" and the panel stays empty, rather than drawing a flat line you could mistake for silence.',
  },
  'dns-zones': {
    what: 'Every DNS zone that loaded, which view it sits in, how many records it holds, and how long answers are cached.',
    look: 'Rows with a problem are tinted red. A dash under TTL means the zone publishes none, and "not checked" means the checks never ran — not that the zone is clean.',
  },
  'dns-dnssec-health': {
    what: 'How many of your zones are signed against tampering, how many are not, and the share that is signed.',
    look: 'The table below lists only the unsigned zones, 150 at most. When every zone is signed it says so there instead of leaving the space blank.',
  },
  'dns-rpz': {
    what: 'The policy zones that block or rewrite DNS answers, each with its severity, what it overrides, its type, and whether it is switched on.',
  },
  'dns-dtc-lbdn': {
    what: 'Names that hand out different answers to spread traffic across servers, with the rule each one follows and whether it is switched on.',
  },

  // ---- Security ----
  'security-threat-events': {
    what: 'DNS lookups from your own network that an outside threat feed flagged in the last hour, counted by the hour of day they happened.',
    look: 'The four figures on top are red for critical, pink for high, amber for medium, blue for low. If the feed cannot be reached the panel says so rather than showing zero.',
  },
  'security-response-summary': {
    what: 'What happened to the flagged lookups: how many were stopped, how many were only written down, and the total.',
    look: 'The red figure counts critical events nobody has ticked off yet — it falls as you tick rows in the list below.',
  },
  'security-triage-inbox': {
    what: 'One row per flagged lookup, worst first: the name that was asked for, what the system did about it, and when.',
    look: 'The buttons filter to one severity; ticking a row fades it. Block says "blocked" only after re-reading the list to confirm; "unconfirmed" means it may or may not have applied.',
  },
  'security-lookalike-domains': {
    what: 'Domains somebody else registered that are spelled to look like yours, and which of your real domains each one imitates.',
    look: 'A red "yes" means it was judged suspicious. A dash instead of a count means the feed could not be reached, so nothing was checked; 0 means checked and none found.',
  },
  'security-ctem-exposure': {
    what: 'Weaknesses found on your internet-facing assets, grouped by how serious they are and how urgent the source rates fixing them.',
    look: 'Severity is red for critical, pink for high, amber for medium, blue for low. Click a heading to re-sort. If the outside feed cannot be read the panel says so.',
  },
  'security-threat-feed-activity': {
    what: 'How many requests matched the threat feed each day, split into ones that were stopped and ones that were let through.',
    look: 'Each day is one column: the red part was blocked, the blue cap on top was let through. Point at a column to read both figures.',
  },
  'security-soc-insights': {
    what: 'Threat campaigns the security service has raised against your tenant, with how many events each caused and when it was last seen.',
    look: 'A column that reads the same on every row is hidden to save space. A dash means the source never reported that figure; it does not mean zero.',
  },
  'security-asset-insights': {
    what: 'A single count of the security findings raised against your assets.',
    look: 'When the source cannot break that total down by severity, a line says so — the split is never guessed.',
  },
  'security-exposures': {
    what: 'The individual weaknesses found on your internet-facing assets, each with when it was first noticed and last confirmed.',
    look: 'Rows come in the source’s own order, not worst first. The line above the table says how many of the full total loaded, or that the total itself is unknown.',
  },
  'security-asset-risk': {
    what: 'Your internet-facing assets with the most problems first: name and address, kind, how many weaknesses, how many ports.',
    look: 'Sorted by weakness count until you click a heading to sort by something else.',
  },
  'security-exposed-surface': {
    what: 'The names and IP addresses of yours that can be reached from the internet, side by side.',
    look: 'Only the first 25 of each are drawn; the corner carries the full counts, or says "rows loaded" when the real total could not be confirmed. Either side can fail alone.',
  },
  'security-ctem-assets': {
    what: 'A roll-up of the assets Infoblox watches for exposure: how many different values of each kind were found, with a few examples.',
    look: 'Each chip is one real example, six per group at most; "+N more" is how many were left undrawn.',
  },

  // ---- Infra ----
  'infra-host-status': {
    what: 'Your Infoblox machines grouped by state. "Unknown" is its own group: nothing reported a state for those, which is not the same as offline.',
    look: 'The percentages are shares of the machines that loaded, not of the whole estate. When those two numbers differ, a line under the list says so.',
  },
  'infra-host-health': {
    what: 'Each machine Infoblox reports on directly, the state it is in, and the software version it is running.',
    look: 'The number by the title counts the machines that came back; it reads at most 500. "feed unavailable" means the read failed, not that you have none.',
  },
  'infra-onprem-hosts': {
    what: 'The Infoblox boxes installed on your own sites, and how many Infoblox applications each one is running.',
    look: 'Only the first five are listed. OPH ID is the identifier Infoblox uses for that box; Apps is how many services are loaded onto it.',
  },
  'infra-asset-discovery': {
    what: 'How many devices discovery is currently tracking. A total only, with no breakdown behind it; the Assets tab is the list those devices come from.',
  },
  'infra-jobs': {
    what: 'Recent background tasks Infoblox ran for this tenant — when each was created, what kind it was, and how it ended.',
    look: '50 tasks at most. User is deliberately cut at the @ sign, so you can see who ran a task without the full email address ever leaving the server.',
  },
  'infra-dfp-services': {
    what: 'The on-site relays that forward your DNS queries to Infoblox for filtering, and whether each one is up.',
    look: 'An empty panel means none are configured; a read that failed says "feed unavailable" instead, so the two never look the same.',
  },
  'infra-host-inventory': {
    what: 'Every machine that loaded, with its address, what state it is in, and what type of machine it is.',
    look: 'Search by name or address, or narrow by type. Sorting by Status puts offline first, then struggling, then the ones with no state reported — worst first, not A to Z.',
  },

  // ---- Assets ----
  'assets-filter-bar': {
    what: 'How many devices discovery has found in total, and one chip per type — the types this tenant actually has, not a catalogue of all of them.',
    look: 'Click a chip to show only that type; click it again to clear. Nothing here refreshes on a timer — Refresh is how you ask the server again.',
  },
  'assets-list': {
    what: 'One row per device, 50 to a page. Searching, sorting and paging all happen on the server, so a sort reorders the whole estate, not this page.',
    look: 'Click a row to open its extra fields below. Provider and Vendor share one column while every row agrees on both, and split back into two when they stop.',
  },
  'assets-detail': {
    what: 'The five fields kept out of the table because most devices have none of them: operating system, IP and MAC addresses, model and location.',
    look: '"not recorded" means nobody filled that field in, not that the device has none. If the device was removed since the list loaded, this says so plainly.',
  },

  // ---- Incidents ----
  'incidents-categories': {
    what: 'One chip per kind of problem currently found, showing how many there are and the colour of the worst one in that group.',
    look: 'Click a chip again to clear it. If a check could not finish you get a warning here, never an all-clear — a missing kind may never have been looked at.',
  },
  'incidents-severity': {
    what: 'How the problems in the list below split across the four seriousness levels.',
    look: 'A dash instead of a count means nothing could be counted; it does not mean zero. When the list is capped these count only what is on screen.',
  },
  'incidents-triage': {
    what: 'Every problem the last check found: what it affects, how serious it is, and how long ago it first appeared.',
    look: 'Ticking Ack fades a row so you can see what is left — it only affects your screen and is gone on reload. Age reads "unknown" when nothing ever recorded a first sighting.',
  },
  'incidents-soc-queue': {
    what: 'Work raised outside this dashboard that still needs somebody to act on it.',
    look: 'Click the wording to see everything recorded about an item. Resolve marks it done and Reopen puts it back — both need operator rights, and say so if you lack them.',
  },
  'incidents-action-volume': {
    what: 'The same work items counted by the day each was last touched, so a growing backlog is visible.',
    look: 'The three figures underneath split those items by how urgent they are. An item with no usable date is missing from the bars but still counted below them.',
  },

  // ---- Audit ----
  'audit-activity-summary': {
    what: 'A tally of the recorded actions below: how many worked, how many failed, and how many came back with no result at all.',
    look: 'One bar per kind of change: green created, blue updated, red deleted. The "unknown" figure only appears when at least one action reported nothing back.',
  },
  'audit-log': {
    what: 'Every change made through this app — who made it, what it touched, whether it worked. Readable and searchable here, but not downloadable.',
    look: 'The line above the table says whether the record has been tampered with. "Could not be verified" is not the same as intact, and the command shown checks it independently.',
  },
  'audit-csp-portal': {
    what: 'Actions taken in the Infoblox portal itself, by people and by machine accounts, rather than through this app.',
    look: 'Recent activity loads by itself; typing a user or resource and pressing Search narrows that same list. Failed results are red, successful ones green. Nothing here downloads.',
  },

  // ---- Changes ----
  'changes-notability': {
    what: 'What was deleted in the last 24 hours, what failed, what happened between 20:00 and 08:00, and who acted for the first time.',
    look: 'A dash instead of a count means the question could not be answered; it does not mean zero. A warning appears here when the 500-event limit was reached.',
  },
  'changes-changed-objects': {
    what: 'Portal actions from the last 24 hours, 500 at most: the local time, what was done, whether it succeeded, and which account did it.',
    look: 'The dot at the start of a row is red for a deletion or a failure, amber for out of hours, grey for routine. Each group heading counts its own rows, not the whole day.',
  },

  // ---- Provision ----
  'provision-subnet-request': {
    what: 'The details for one new subnet: which space and address block it is carved out of, how big it is, and what to call it.',
    look: 'Preview runs the whole job without creating anything; the green Provision button appears only after that, and disappears again the moment you edit a field.',
  },
  'provision-subnet-log': {
    what: 'Every step the server reports while it works, in the order it happens.',
    look: 'Grey is progress, red is a failure, green is the finish. After a preview the last line says nothing was written.',
  },
  'provision-subnet-result': {
    what: 'What Infoblox handed back for the subnet just created — its id and address. Only a real run produces this; a preview never does.',
  },
  'provision-site-request': {
    what: 'Which saved site template to build, and optionally an IP space to build it into instead of the one the template names.',
    look: 'A template listed as (invalid) has an error in its own file and cannot be selected. Preview walks the whole plan without creating anything; the button to build for real appears only after that.',
  },
  'provision-site-log': {
    what: 'The server’s running commentary on the site build — one line per thing it creates, or would create on a preview.',
    look: 'Red is a failure, green is the finish. Only the newest run is kept; starting another clears it.',
  },
  'provision-site-result': {
    what: 'What the build produced: the address block it used, the DNS zone, and how many subnets, DHCP ranges and hosts it made.',
    look: 'If that site already existed it says Skipped instead, and nothing was changed.',
  },
  'provision-site-teardown': {
    what: 'Removes the objects created by the template chosen in the panel above — there is no separate picker here.',
    look: 'Anyone can preview. The red button needs an admin token and the site name typed in exactly, and there is no undo once it runs.',
  },
  'provision-site-teardown-log': {
    what: 'Each object the teardown deletes as it goes — or on a preview, each one it would delete and does not.',
    look: 'Red lines are objects it could not delete.',
  },
  'provision-site-teardown-result': {
    what: 'Which site was targeted, whether its DNS zone went with it, and how many subnets, DHCP ranges and hosts were removed.',
    look: 'After a preview these are the counts it would remove — an amber line at the bottom says nothing was actually deleted.',
  },
  'provision-seed-request': {
    what: 'Which of the three regions to build demo sites for, and which IP space to put them in.',
    look: 'Untick every region and the buttons switch off. These same tick boxes also decide what the teardown panel further down will remove.',
  },
  'provision-seed-progress': {
    what: 'How many of this run’s templates have finished and how many failed, counting up as it goes.',
    look: 'Every failure is listed by name with its reason, and the count turns red as soon as there is one.',
  },
  'provision-seed-log': {
    what: 'The line-by-line output of the run, each line tagged with the template it came from.',
    look: 'Red is a failure, green is the finish. It holds only the current run — starting another clears it.',
  },
  'provision-seed-summary': {
    what: 'The count of templates: how many built, how many failed, and how many were skipped because that site already existed.',
  },
  'provision-seed-teardown': {
    what: 'Deletes what a seed run created in whichever regions are ticked above, plus the shared pool of regional address blocks.',
    look: 'Anyone can preview. The red button needs an admin token and the word DELETE typed in, and nothing can be brought back afterwards.',
  },
  'provision-seed-teardown-progress': {
    what: 'How many templates the teardown has got through and how many it could not, counting up as it goes. A failure is not undone; it moves on to the next template.',
  },
  'provision-seed-teardown-log': {
    what: 'The line-by-line output of the teardown, each line tagged with the template it came from.',
    look: 'Red lines are objects it could not delete. On a preview the last line says nothing was deleted.',
  },
  'provision-seed-teardown-summary': {
    what: 'The count of templates the teardown got through and failed on. Skipped stays at zero — a teardown never skips one.',
  },

  // ---- SelfService ----
  'selfservice-allocate': {
    what: 'Takes free addresses out of a subnet you choose and reserves them, optionally under a name you give.',
    look: 'Preview only asks the server to check the request — nothing is taken. Allocate then commits it immediately; nobody approves it. Changing a field cancels the preview.',
  },
  'selfservice-create-record': {
    what: 'Adds a new entry to a DNS zone you already have, pointing a name at an address or another name.',
    look: 'Preview checks the details and creates nothing. Create commits straight away, with no approval step. Edit anything afterwards and you have to preview again.',
  },
  'selfservice-manage-records': {
    what: 'Everything a zone you pick currently points at, 200 entries at most; a line above the list says when there are more than that.',
    look: 'Update needs a preview first, and stops rather than overwriting if the entry moved since you looked. Delete takes two clicks. Some types are shown but cannot be edited.',
  },
  'selfservice-manage-addresses': {
    what: 'The addresses handed out in one subnet, with what state each is in and who it belongs to.',
    look: 'Release hands an address back to the free pool. It takes two clicks to confirm and then happens immediately — there is no preview and no undo.',
  },

  // ---- Editor ----
  'editor-object-form': {
    what: 'A form that creates one DNS, address, DHCP or host object, or changes an existing one once you paste its ID into the first box.',
    look: 'Preview shows exactly what would be sent and saves nothing; only Create or Update writes it. Changing any field withdraws the preview. Delete takes two clicks and is final.',
  },

  // ---- Drift ----
  'drift-check': {
    what: 'Picks which site template a real site is measured against. The list holds every site template this system knows of.',
    look: 'IP space is optional: left alone, the template decides. The button stays greyed out until a template is chosen. Running it only reads, it changes nothing.',
  },
  'drift-error': {
    what: 'Shows only when the comparison could not run, with whatever the server said went wrong. Nothing was compared, so this is not a verdict that the site is fine.',
  },
  'drift-result': {
    what: 'Where the site differs from the template: each line is either missing, changed to something else, or there but not asked for.',
    look: 'A red count is how many differences were found, green means none. Six per group are shown, worst group first; "+N more" opens the rest.',
  },

  // ---- Ai ----
  'ai-ask': {
    what: 'Ask about your own network in ordinary words. Answers are built by running real lookups against your data, not from what the model remembers.',
    look: 'Each answer lists the lookups behind it and the count each returned, so the wording can be checked against the figures. The token line counts this server only.',
  },
  'ai-threat-lookup': {
    what: 'Type one domain, IP address or host name and see what is known about it on the threat feeds.',
    look: 'A link under the result opens the full dossier — the same name seen through your assets, DNS, IPAM and recent changes. Blocking needs a dashboard token.',
  },
}
