import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts, which is what
// took this file off playwright.config.ts's LIVE_TENANT_SPECS list on
// 2026-08-13. It was excluded from CI because it asserts on data only a live
// Infoblox tenant serves; the fixtures are that data, identical on every
// machine, so it now runs on the ubuntu runner too.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});


// Predicate P2a for item 1 (unified search -> expanded dossier page).
//
// The pure half — which strings count as an IP or a hostname — is proved
// without a browser in ui/src/lib/indicator.test.js under `cd ui && npm test`.
// What only a browser can show is the four things this file asserts:
//
//   1. the palette offers a NON-TAB row for a literal indicator, and offers
//      nothing new for a tab-name query (the named regression risk);
//   2. #dossier?q=… paints all five source rows on the FIRST render, before any
//      of the five fetches has answered;
//   3. each source resolves on its own — a slow source holds nothing else up
//      (decision D3), which is proved by stalling one and watching four land;
//   4. the four availability states render distinguishably, and "unsupported"
//      never renders as "nothing found". That last clause is the whole reason
//      the server answers 200 for its own failures (go/internal/server/
//      search.go): a section that could not be asked must not read as a
//      section that was asked and came back clean.
//
// Everything except the LIVE block at the bottom is faked with page.route, so
// it does not depend on what the tenant happens to hold today. The live block
// is what proves the five endpoints really answer for a real indicator.

const SOURCES = ['assets', 'dns', 'ipam', 'threat', 'changes'] as const;

// The ribbon's five words, transcribed from SURFACE B of
// .mockups/build-bloxsmith-ux/bloxsmith-ux-v11.html. They are asserted because
// the ribbon once derived them by taking the first word of the ledger's row
// label, which rendered "IP address management" as "IP" and "Recent changes" as
// "Recent" — so with the na state the ribbon read "IP N/A".
const RIBBON_LABELS: Record<(typeof SOURCES)[number], string> = {
  assets: 'Assets',
  dns: 'DNS',
  ipam: 'IPAM',
  threat: 'Threat',
  changes: 'Changes',
};

// A terminal state is anything that is not still loading. Named here once so a
// test can say "resolved" without enumerating the outcomes each time.
const TERMINAL = ['ok', 'none', 'unsupported', 'error', 'noquery', 'na'];

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function delayThen(route: import('@playwright/test').Route, ms: number, body: unknown) {
  await new Promise((r) => setTimeout(r, ms));
  return fulfillJson(route, body);
}

// Row shapes copied from the live server on 2026-08-06, not invented:
//   /api/search/ipam?q=172.16.128.1  -> {availability, limit, rows:[{address, comment, id, name, space, state}], total}
//   /api/search/dns?q=app-dc1-prod.acme.corp -> {availability, rows:[{absolute_name_spec, absolute_zone_name, dns_rdata, id, name_in_zone, ttl, type, zone, comment, disabled}], truncated}
//   /api/csp/assets?q=debug-vpcflow  -> {availability, rows:[{cqid, last_seen, name, provider, type, vendor}], ...}
//   /api/csp-audit?q=…               -> {count, rows:[{action, id, resource, result, ts, user, who_kind, who_role}], status, truncated}
const FAKE = {
  assets: {
    availability: 'ok',
    rows: [{ cqid: 'c1', last_seen: '2026-08-07T00:48:04.000', name: 'nios-demo-ns1', provider: 'AWS', type: 'Virtual Machine', vendor: 'AWS' }],
    total: 1,
  },
  dns: {
    availability: 'ok',
    rows: [{
      absolute_name_spec: 'app-dc1-prod.acme.corp.', absolute_zone_name: 'acme.corp.', dns_rdata: '10.4.0.53',
      id: 'dns/record/1', name_in_zone: 'app-dc1-prod', ttl: 28800, type: 'A', zone: 'dns/auth_zone/1', comment: '', disabled: false,
    }],
    truncated: false,
  },
  ipam: {
    availability: 'ok',
    rows: [{ address: '172.16.128.1', comment: 'Auto-created by vdiscovery', id: 'ipam/address/1', name: null, space: 'ipam/ip_space/78d386a0', state: 'used' }],
    total: 1,
  },
  changes: {
    count: 1,
    rows: [{ action: 'UPDATE', id: '1556846064', resource: 'auth_zone', result: 'success', ts: '2026-08-07T01:29:09.271384Z', user: 'provider_id.abc', who_kind: 'service', who_role: 'ib-x-dns-admin' }],
    status: 'ok',
    truncated: false,
  },
  // The dossier's verdict shape: a summary AND at least one examined source.
  // Both halves matter — DossierPanel.jsx:282-293 refuses a verdict without an
  // examined source, and the ledger row mirrors that same refusal.
  threat: {
    query: '172.16.128.1',
    type: 'ip',
    // assessed: true — #89 made a clean verdict opt-in, so a fixture that means
    // "somebody graded this and found nothing" has to say so.
    summary: { actor: '', assessed: true, country: 'US', malicious: false, max_threat_level: 0, properties: [], registrar: '', threat_classes: [] },
    sources: [{ source: 'whois', whois: '{}' }, { source: 'geo', geo: {} }],
  },
};

// Route every one of the five, each with its own body and its own delay.
async function routeAll(
  page: import('@playwright/test').Page,
  opts: { bodies?: Partial<Record<(typeof SOURCES)[number], unknown>>; delays?: Partial<Record<(typeof SOURCES)[number], number>> } = {},
) {
  const url: Record<(typeof SOURCES)[number], string> = {
    assets: '**/api/csp/assets?*',
    dns: '**/api/search/dns?*',
    ipam: '**/api/search/ipam?*',
    threat: '**/api/dossier?*',
    changes: '**/api/csp-audit?*',
  };
  for (const s of SOURCES) {
    const body = opts.bodies?.[s] ?? FAKE[s];
    const delay = opts.delays?.[s] ?? 0;
    await page.route(url[s], (route) => (delay ? delayThen(route, delay, body) : fulfillJson(route, body)));
  }
}

const row = (page: import('@playwright/test').Page, s: string) => page.locator(`[data-dossier-source="${s}"]`);

// Cmd/Ctrl-K is served by a window keydown listener that App.jsx attaches in an
// effect, so a press issued between "navigation resolved" and "React mounted"
// lands on nobody and is simply lost. playwright.config.ts already names this
// race as the reason the suite retries once; pressing again until the dialog
// appears removes it here instead of absorbing it, which matters because these
// specs assert on the CONTENTS of that dialog and a lost keypress would read as
// "the indicator row is missing".
async function openPalette(page: import('@playwright/test').Page) {
  // The nav is rendered by the same component tree that owns the listener, so
  // its presence is the closest available proxy for "the effect has run".
  await page.locator('nav[aria-label="Sections"]').waitFor();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  return dialog;
}

// ---------------------------------------------------------------------------
// 1. The palette
// ---------------------------------------------------------------------------

test.describe('palette: indicator search', () => {
  test('a literal IP offers a result that is not a tab name', async ({ page }) => {
    await page.goto('/#overview');
    const dialog = await openPalette(page);
    await dialog.locator('input').fill('172.16.128.1');

    const options = dialog.getByRole('option');
    await expect(options.first()).toContainText('Search estate for 172.16.128.1');
    // Not a tab name: no tab is called this, and it is the ONLY hit, because
    // an IP matches no tab label.
    await expect(options).toHaveCount(1);
  });

  test('picking it lands on the dossier page for that query', async ({ page }) => {
    await routeAll(page);
    await page.goto('/#overview');
    const dialog = await openPalette(page);
    await dialog.locator('input').fill('app-dc1-prod.acme.corp');
    await dialog.getByRole('option').first().click();

    await expect(page).toHaveURL(/#dossier\?q=app-dc1-prod\.acme\.corp/);
    await expect(row(page, 'dns')).toBeVisible();
  });

  test('an empty query still lists every tab and offers no indicator row', async ({ page }) => {
    await page.goto('/#overview');
    const dialog = await openPalette(page);
    // 15 tabs, unchanged — the palette still receives TABS, never PAGES, so
    // the hidden dossier page must not be in this list.
    await expect(dialog.getByRole('option')).toHaveCount(15);
    await expect(dialog.getByText(/Search estate for/)).toHaveCount(0);
    await expect(dialog.getByRole('option', { name: /^Dossier$/ })).toHaveCount(0);
  });

  test('a tab-name query is untouched by the indicator row', async ({ page }) => {
    await page.goto('/#overview');
    const dialog = await openPalette(page);
    await dialog.locator('input').fill('dns');
    await expect(dialog.getByText(/Search estate for/)).toHaveCount(0);
    await expect(dialog.getByRole('option').first()).toHaveText('DNS');
    // Enter still jumps to the tab, exactly as before.
    await dialog.locator('input').press('Enter');
    await expect(page).toHaveURL(/#dns$/);
  });
});

// ---------------------------------------------------------------------------
// 2. All five sections paint before any of them answers
// ---------------------------------------------------------------------------

test('all five sources are on screen while every fetch is still in flight', async ({ page }) => {
  await routeAll(page, { delays: { assets: 9000, dns: 9000, ipam: 9000, threat: 9000, changes: 9000 } });
  await page.goto('/#dossier?q=172.16.128.1');

  // Four are in flight. "Recent changes" is the fifth row and is on screen with
  // the rest, but it is never in flight for ANY query — see the audit gate test
  // below — so it is settled at `na` from the first render instead of loading.
  for (const s of SOURCES) {
    await expect(row(page, s)).toBeVisible();
    await expect(row(page, s)).toHaveAttribute('data-dossier-state', s === 'changes' ? 'na' : 'loading');
  }
  // The query bar names what it recognised, so the page is not a mystery while
  // it loads.
  await expect(page.getByText('IPv4 address')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Progressive rendering (decision D3)
// ---------------------------------------------------------------------------

test('one stalled source does not hold up the other four', async ({ page }) => {
  await routeAll(page, { delays: { threat: 8000 } });
  await page.goto('/#dossier?q=172.16.128.1');

  for (const s of ['assets', 'dns', 'ipam']) {
    await expect(row(page, s)).toHaveAttribute('data-dossier-state', 'ok', { timeout: 5000 });
  }
  // The fourth of the four is "Recent changes", which settles without a fetch.
  await expect(row(page, 'changes')).toHaveAttribute('data-dossier-state', 'na');
  // …and threat intel is demonstrably still waiting at that moment.
  await expect(row(page, 'threat')).toHaveAttribute('data-dossier-state', 'loading');
});

// ---------------------------------------------------------------------------
// 4. The four availability states, told apart
// ---------------------------------------------------------------------------

test.describe('availability states', () => {
  test('ok with rows shows the row identity and its fields', async ({ page }) => {
    await routeAll(page);
    await page.goto('/#dossier?q=172.16.128.1');
    await expect(row(page, 'ipam')).toHaveAttribute('data-dossier-state', 'ok');
    await expect(row(page, 'ipam')).toContainText('172.16.128.1');
    await expect(row(page, 'ipam')).toContainText('used');
    await expect(row(page, 'assets')).toContainText('nios-demo-ns1');
    await expect(row(page, 'assets')).toContainText('Virtual Machine');
    await expect(row(page, 'dns')).toContainText('app-dc1-prod.acme.corp.');
    await expect(row(page, 'dns')).toContainText('28800');
  });

  test('ok with zero rows says we asked and found none — and says nothing else', async ({ page }) => {
    await routeAll(page, { bodies: { dns: { availability: 'ok', rows: [], truncated: false } } });
    await page.goto('/#dossier?q=172.16.128.1');
    await expect(row(page, 'dns')).toHaveAttribute('data-dossier-state', 'none');
    await expect(row(page, 'dns')).toContainText(/no matching DNS records/i);
    await expect(row(page, 'dns')).not.toContainText(/could not|unavailable/i);
  });

  test('unsupported never reads as nothing found', async ({ page }) => {
    await routeAll(page, {
      bodies: {
        dns: {
          availability: 'unsupported',
          reason: "search across all zones/spaces is not supported by this tenant's API",
          rows: [],
        },
      },
    });
    await page.goto('/#dossier?q=172.16.128.1');
    const dns = row(page, 'dns');
    await expect(dns).toHaveAttribute('data-dossier-state', 'unsupported');
    // The page sets a typographic apostrophe (U+2019); both forms are accepted
    // here so this assertion is about the sentence, not about the glyph.
    await expect(dns).toContainText(/can[’']t be asked/i);

    // The clause this whole spec exists for. None of the zero-count vocabulary
    // may appear anywhere in this section.
    const why = page.locator('[data-dossier-why="dns"]');
    await expect(why).toBeVisible();
    await expect(why).toContainText(/unknown/i);
    // The ledger row itself carries none of the zero-count vocabulary — that is
    // the line an operator scans, and it must not say "none".
    await expect(dns).not.toContainText(/no data|nothing found|no matching/i);

    // "Nothing found" DOES appear once in the section, and only there: inside
    // the why block's "Not this" line, which exists to name that reading and
    // reject it. Asserting its absence outright would have deleted the very
    // sentence this state needs, so what is asserted is where it lives.
    const notThis = why.locator('text=Not this').locator('..');
    await expect(notThis).toContainText(/Nothing found/i);
    await expect(why).toContainText(/We could not ask/i);
  });

  // The body here is the csp rowsResp shape (`status: 'error'`, csp.go:850) and
  // it is deliberately still the shape being asserted — what changed on
  // 2026-08-07 is only WHICH row receives it. This case used to be delivered to
  // "Recent changes"; that row no longer makes a request at all, so it can no
  // longer reach `error`, and asserting it there would have been asserting a
  // state the page can never paint. Assets is a row that does fetch, and
  // stateOf reads `availability ?? status`, so the same body still proves the
  // same thing: a dead feed reads as unreadable, never as "nothing found".
  test('error is a dead feed, told apart from a refused question', async ({ page }) => {
    await routeAll(page, {
      bodies: { assets: { count: 0, rows: [], status: 'error', truncated: false } },
    });
    await page.goto('/#dossier?q=172.16.128.1');
    const assets = row(page, 'assets');
    await expect(assets).toHaveAttribute('data-dossier-state', 'error');
    await expect(assets).toContainText(/could not be read/i);
    await expect(page.locator('[data-dossier-section="assets"]')).not.toContainText(/no asset/i);
  });

  test('no query at all is its own state, not an empty result', async ({ page }) => {
    await routeAll(page);
    await page.goto('/#dossier');
    for (const s of SOURCES) {
      await expect(row(page, s)).toHaveAttribute('data-dossier-state', 'noquery');
    }
    await expect(page.getByText(/type an IP or a hostname/i).first()).toBeVisible();
  });

  // A question that cannot apply is a FIFTH outcome, and the reason it exists
  // is measured, not theoretical: /api/search/ipam filters on address=="<q>",
  // so a hostname query made the live tenant answer HTTP 500 and the row
  // painted "Unavailable / could not be read" on 2026-08-06. That is a lie of
  // the exact kind this page is built to avoid — it trains an operator to
  // distrust a page that is working correctly. The fix is not a nicer label;
  // it is not asking, which is why the absence of the request is asserted here
  // as hard as the wording is.
  test('IPAM is never asked about a hostname, and says so calmly', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/search/ipam')) asked.push(r.url());
    });
    await routeAll(page);
    await page.goto('/#dossier?q=app-dc1-prod.acme.corp');

    const ipam = row(page, 'ipam');
    await expect(ipam).toHaveAttribute('data-dossier-state', 'na');
    await expect(ipam).toContainText(/searched by IP address/i);

    // Distinct from all four existing outcomes, in the words as well as the
    // attribute: it is not a failure, and it is not an empty result.
    await expect(ipam).not.toContainText(/unavailable|could not|can[’']t be asked/i);
    await expect(ipam).not.toContainText(/no IPAM address object|nothing found|no data/i);
    // The why block belongs to the two UNKNOWN states. Nothing here is
    // unknown, so it must not appear — a warning stripe would undo the point.
    await expect(page.locator('[data-dossier-why="ipam"]')).toHaveCount(0);

    // Wait for a source that DOES apply, so "no request" is being asserted
    // after the page has demonstrably done its fetching, not before it started.
    await expect(row(page, 'dns')).toHaveAttribute('data-dossier-state', 'ok');
    expect(asked, `IPAM was asked a question it cannot answer: ${asked.join(', ')}`).toHaveLength(0);
  });

  test('an IP query still asks IPAM — the gate closes on shape, not on everything', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/search/ipam')) asked.push(r.url());
    });
    await routeAll(page);
    await page.goto('/#dossier?q=172.16.128.1');
    await expect(row(page, 'ipam')).toHaveAttribute('data-dossier-state', 'ok');
    expect(asked).toHaveLength(1);
  });

  // The mirror case, pinned so a later change cannot quietly widen the gate:
  // DNS with an IP query is a REAL question (a reverse lookup), and the live
  // tenant answered it with a genuine zero on 2026-08-06. It must keep
  // reaching the network and keep reading as "none", never as "n/a".
  test('DNS is still asked about an IP — a reverse lookup is a real question', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/search/dns')) asked.push(r.url());
    });
    await routeAll(page, { bodies: { dns: { availability: 'ok', rows: [], truncated: false } } });
    await page.goto('/#dossier?q=172.16.128.1');
    await expect(row(page, 'dns')).toHaveAttribute('data-dossier-state', 'none');
    expect(asked).toHaveLength(1);
  });

  // The second gate, and a harder one than IPAM's: IPAM cannot answer about a
  // hostname, but the audit log cannot answer about ANY indicator. Read off
  // go/internal/dashboard/csp.go:824 — the only clause the route ever builds
  // from q is `(user_name~q or resource_type~q)`, i.e. WHO made the change and
  // WHAT KIND of object it was. The changed object's own name or address is in
  // neither field, so for "10.4.12.7" and for "app-dc1-prod.acme.corp" alike
  // both sides of the `or` are dead. The route then answers `{rows:[],
  // status:"ok"}`, which the page read as `none` and printed as "no change
  // touching this in the audit window — we asked, and the log holds none": a
  // proven negative for a question the endpoint was never able to ask. That
  // sentence fired on every single indicator search, not on a failure.
  for (const q of ['172.16.128.1', 'app-dc1-prod.acme.corp']) {
    test(`the audit log is never asked about ${q} — it cannot search by the thing that changed`, async ({ page }) => {
      const asked: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/csp-audit')) asked.push(r.url());
      });
      await routeAll(page);
      await page.goto(`/#dossier?q=${encodeURIComponent(q)}`);

      const changes = row(page, 'changes');
      await expect(changes).toHaveAttribute('data-dossier-state', 'na');
      // It says what it DOES search by, so the row is informative rather than
      // merely quiet.
      await expect(changes).toContainText(/who made/i);
      await expect(changes).toContainText(/what kind of object/i);
      // None of the proven-negative vocabulary, and none of the alarm
      // vocabulary: nothing is broken and nothing was found to be absent.
      await expect(changes).not.toContainText(/no change|holds none|nothing found|no data/i);
      await expect(changes).not.toContainText(/unavailable|could not/i);
      await expect(page.locator('[data-dossier-why="changes"]')).toHaveCount(0);

      // Asserted only after a source that DOES fetch has come back, so "never
      // asked" is a statement about a page that has finished its network work.
      await expect(row(page, 'dns')).toHaveAttribute('data-dossier-state', 'ok');
      expect(asked, `csp-audit was asked: ${asked.join(', ')}`).toHaveLength(0);
    });
  }

  test('a dossier body with no examined source gets no verdict', async ({ page }) => {
    // Mirrors DossierPanel.jsx:282-293. sources: [] is an array, and a summary
    // is present — the exact body that once painted a false CLEAN.
    await routeAll(page, {
      bodies: { threat: { query: '172.16.128.1', summary: { malicious: false, assessed: true }, sources: [] } },
    });
    await page.goto('/#dossier?q=172.16.128.1');
    const threat = row(page, 'threat');
    await expect(threat).toHaveAttribute('data-dossier-state', 'error');
    // No verdict is offered at all — the Verdict field only exists on an `ok`
    // row, so its absence is the assertion. (The section DOES contain the word
    // "clean", in the sentence "…is unknown, not clean" — that sentence is the
    // point of the why block, so this cannot be a bare word search.)
    await expect(threat).not.toContainText(/Verdict/i);
    // …and the embedded panel — which sits below the whole ledger, so that a
    // 300px block does not break the five-jack scan — refuses the same body on
    // its own unedited guard, and paints no CLEAN pill.
    const panel = page.locator('[data-dossier-panel]');
    await expect(panel).toContainText(/Dossier unavailable/i);
    await expect(panel).not.toContainText(/\bCLEAN\b/);
  });
});

// ---------------------------------------------------------------------------
// 5. The AI tab keeps its inline panel and gains a way out
// ---------------------------------------------------------------------------

test('the AI tab lookup still renders inline and links to the full page', async ({ page }) => {
  await page.route('**/api/dossier?*', (route) => fulfillJson(route, FAKE.threat));
  await page.route('**/api/threat-lookup?*', (route) => fulfillJson(route, { entities: [], query: '172.16.128.1' }));
  await page.goto('/#ai');
  // Scoped by the lookup box's own placeholder, not by walking up from the card
  // title: `text=Threat lookup` + two `..` hops resolves to an ancestor that
  // holds an earlier card's input too, and filling THAT left the Lookup button
  // disabled (it is disabled until this specific input has a value).
  const input = page.getByPlaceholder('domain, IP, or host…');
  await input.fill('172.16.128.1');
  // `exact: true` for the same reason the other five call sites in this suite
  // already have it (failure-not-absence, failure-not-absence-2,
  // dossier-empty-sources): an accessible name matches as a SUBSTRING by
  // default, and this panel's About button is named "About: Threat lookup", which
  // contains "Lookup". Exact is the stricter assertion, not a looser one.
  await page.getByRole('button', { name: 'Lookup', exact: true }).click();

  // Page-scoped: the AI tab has exactly one of each of these, and walking up
  // from the input lands on whichever ancestor `.first()`/`.last()` happens to
  // pick — an inner flex row that holds the input but not the link.
  const link = page.getByRole('link', { name: /open full dossier/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '#dossier?q=172.16.128.1');
  // Nothing was removed: the inline panel is still on screen, with the verdict
  // it has always rendered.
  await expect(page.getByText('CLEAN', { exact: true }).first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 6. The page speaks: one polite live region, paced
// ---------------------------------------------------------------------------
//
// Verified absent on 2026-08-06: the page carried no aria-live region and no
// role="status" anywhere, so five rows flipped from Loading to their resolved
// state in silence and Enter in the query box announced nothing at all. The
// state words are real text and always were; what was missing was any signal
// that the page had CHANGED.
//
// Pacing is asserted as hard as presence, and for a measured reason: four of
// the five sections settle within milliseconds of each other (three fetches
// plus the ungated "Recent changes" row), so an announcement per section would
// be four messages in one burst, each overwriting the previous before a screen
// reader could finish it. What is asserted below is that a burst becomes ONE
// message, that a straggler gets its own, and that no message is replaced
// within a second of being set.

const live = (page: import('@playwright/test').Page) => page.locator('[data-dossier-live]');

// Poll the region and keep every distinct message with the time it appeared.
// 100ms is well inside the hold the page applies, so no message can be missed
// between two samples.
async function collectAnnouncements(page: import('@playwright/test').Page, ms: number) {
  const seen: { text: string; at: number }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const text = ((await live(page).textContent()) ?? '').trim();
    if (text && text !== seen[seen.length - 1]?.text) seen.push({ text, at: Date.now() });
    if (/All sources have answered/.test(seen[seen.length - 1]?.text ?? '')) break;
    await page.waitForTimeout(100);
  }
  return seen;
}

test.describe('announcements', () => {
  test('a polite live region exists, and says nothing before there is anything to say', async ({ page }) => {
    await routeAll(page);
    await page.goto('/#dossier');
    const region = live(page);
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveText('');
  });

  test('a burst of resolutions is one announcement, and a straggler gets its own', async ({ page }) => {
    await routeAll(page, { delays: { threat: 4000 } });
    await page.goto('/#dossier?q=172.16.128.1');

    const seen = await collectAnnouncements(page, 20_000);
    const texts = seen.map((s) => s.text);

    // 1. the search itself, 2. the four that settle at once, 3. the straggler.
    expect(texts, `announcements were: ${JSON.stringify(texts)}`).toHaveLength(3);
    expect(texts[0]).toBe('Searching the estate for 172.16.128.1.');
    expect(texts[1]).toMatch(/^Assets: loaded\./);
    expect(texts[1]).toContain('Recent changes: not applicable.');
    expect(texts[1]).toContain('1 source still loading.');
    expect(texts[2]).toBe('Threat intel: loaded. All sources have answered.');

    // No message is replaced before it can be read.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].at - seen[i - 1].at, `message ${i} replaced message ${i - 1} too fast`).toBeGreaterThanOrEqual(1000);
    }
  });

  test('pressing Enter announces the new search', async ({ page }) => {
    await routeAll(page, { delays: { threat: 9000 } });
    await page.goto('/#dossier?q=172.16.128.1');
    await expect(live(page)).toHaveText('Searching the estate for 172.16.128.1.');

    const box = page.getByLabel('Search the estate');
    await box.fill('app-dc1-prod.acme.corp');
    await box.press('Enter');
    await expect(live(page)).toHaveText('Searching the estate for app-dc1-prod.acme.corp.');
  });
});

// ---------------------------------------------------------------------------
// 7. The ribbon's FIRST frame
// ---------------------------------------------------------------------------
//
// `results` is {} until each section's onResult effect has run, and the ribbon
// read `JACK[undefined] ?? JACK.error` — so before any effect fired it painted
// five warn-coloured jacks labelled "Unavailable" beside a blank state word.
// One frame to an eye; the whole story to a screen reader, and to an assertion
// that runs early. A MutationObserver installed before the app boots is what
// makes that frame observable: its callback is a microtask after React commits
// the DOM, which is earlier than the passive effects that fill `results`.
test('the ribbon never paints Unavailable before a source has reported', async ({ page }) => {
  await page.addInitScript(() => {
    const seen: Record<string, true> = {};
    (window as unknown as { __ribbonLabels: Record<string, true> }).__ribbonLabels = seen;
    const snap = () => {
      document.querySelectorAll('[data-dossier-ribbon] [role="img"]').forEach((c) => {
        seen[c.getAttribute('aria-label') ?? '(none)'] = true;
      });
    };
    // `document`, not `document.documentElement`: an init script runs before
    // the parser has created the root element, and observing null throws
    // "parameter 1 is not of type 'Node'" — which silently records nothing and
    // would have made this test pass against the broken page.
    new MutationObserver(snap).observe(document, { childList: true, subtree: true, attributes: true });
  });
  await routeAll(page, { delays: { assets: 9000, dns: 9000, ipam: 9000, threat: 9000, changes: 9000 } });
  await page.goto('/#dossier?q=172.16.128.1');
  await expect(row(page, 'assets')).toHaveAttribute('data-dossier-state', 'loading');

  const labels = Object.keys(
    await page.evaluate(() => (window as unknown as { __ribbonLabels: Record<string, true> }).__ribbonLabels),
  );
  expect(labels, `ribbon jack labels seen: ${labels.join(', ')}`).not.toContain('Unavailable');
  expect(labels).toContain('Loading');
  // The state word beside the jack is never blank either — a jack with no word
  // is the same missing frame, told by the other half of the cell.
  await expect(page.locator('[data-dossier-ribbon="assets"]')).toContainText('Loading');
});

// ---------------------------------------------------------------------------
// 8. Network discipline: a request that never lands, and a locked vault
// ---------------------------------------------------------------------------
//
// useSource had neither of the two guards the shared useApi (ui/src/lib/api.js)
// has applied all along: no abort budget, so a hung feed showed a skeleton for
// ever with no way for the user to learn it had given up; and no handling for
// the 503 the server answers when the vault is locked, which every other panel
// in this app turns into the unlock prompt.
test.describe('network discipline', () => {
  test('a request that never answers is given up on, and says so', async ({ page }) => {
    // The budget is 45s (see DOSSIER_TIMEOUT_MS), so this test has to outlive it.
    test.setTimeout(120_000);
    await routeAll(page);
    // Registered after routeAll so it wins: this handler never fulfills.
    await page.route('**/api/dossier?*', () => {});
    await page.goto('/#dossier?q=172.16.128.1');

    await expect(row(page, 'threat')).toHaveAttribute('data-dossier-state', 'loading');
    await expect(row(page, 'threat')).toHaveAttribute('data-dossier-state', 'error', { timeout: 90_000 });
    const why = page.locator('[data-dossier-why="threat"]');
    await expect(why).toContainText(/stopped waiting/i);
    // Still an UNKNOWN, never a clean bill of health.
    await expect(why).toContainText(/unknown/i);
  });

  test('a locked vault raises the unlock event instead of reading as a dead feed', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __vaultLocked: number }).__vaultLocked = 0;
      window.addEventListener('bx:vault-locked', () => {
        (window as unknown as { __vaultLocked: number }).__vaultLocked++;
      });
    });
    await routeAll(page);
    await page.route('**/api/search/dns?*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'vault locked', locked: true }) }),
    );
    await page.goto('/#dossier?q=172.16.128.1');

    await expect(row(page, 'dns')).toHaveAttribute('data-dossier-state', 'error');
    await expect(row(page, 'dns')).toContainText(/could not be read/i);
    await expect(page.locator('[data-dossier-why="dns"]')).toContainText(/vault locked/i);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __vaultLocked: number }).__vaultLocked))
      .toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. LIVE — no page.route. This is the half of P2a that proves the endpoints.
// ---------------------------------------------------------------------------

test.describe('live tenant', () => {
  // The file-level beforeEach fakes every /api/ response, which is right for the
  // eight blocks above and WRONG here — this block exists to prove the real
  // endpoints answer, so serving it fixtures would leave it green while proving
  // nothing. So it undoes them, and skips itself outright where there is no
  // tenant to reach.
  //
  // This is what let the rest of the file leave LIVE_TENANT_SPECS. The exclusion
  // was per FILE, so 25 tests that need no tenant at all sat out of CI to
  // accommodate these three. Now the skip is per test and CI runs the other 25.
  test.beforeEach(async ({ page }) => {
    test.skip(
      !!process.env.E2E_SKIP_LIVE,
      'proves the real Infoblox endpoints answer — there is no tenant on CI, and fixtures would defeat the purpose',
    );
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  // A COLD /api/dossier is the slow one here: it fans out to real threat
  // sources and only the warm path is milliseconds. Measured warm on
  // 2026-08-06 the five are 1.5ms / 1.4s / 2.8s / 0.13s / 0.16s, but a cold
  // first call blew the default 30s test budget once. This is a budget for the
  // WHOLE test, deliberately generous, and it does not weaken any assertion —
  // every poll below still has to reach a real terminal state.
  test.setTimeout(120_000);

  test('every source answers 200 and reaches a state of its own', async ({ page }) => {
    const statuses: Record<string, number> = {};
    page.on('response', (res) => {
      const u = res.url();
      for (const [k, frag] of [
        ['assets', '/api/csp/assets'],
        ['dns', '/api/search/dns'],
        ['ipam', '/api/search/ipam'],
        ['threat', '/api/dossier'],
        ['changes', '/api/csp-audit'],
      ] as const) {
        if (u.includes(frag)) statuses[k] = res.status();
      }
    });

    await page.goto('/#dossier?q=172.16.128.1');
    for (const s of SOURCES) {
      await expect
        .poll(async () => row(page, s).getAttribute('data-dossier-state'), { timeout: 60_000 })
        .not.toBe('loading');
      const state = await row(page, s).getAttribute('data-dossier-state');
      expect(TERMINAL, `${s} settled on an unknown state: ${state}`).toContain(state!);
    }

    for (const s of ['assets', 'dns', 'ipam', 'threat'] as const) {
      expect(statuses[s], `${s} never answered`).toBe(200);
    }
    // The fifth is asserted the other way round on purpose: /api/csp-audit is
    // measured at 35s on this tenant (its upstream hits the Go REST client's own
    // 35s ceiling, rest.go:23) and it cannot answer this question whatever it
    // returns, so the correct live observation is that it was never called.
    expect(statuses.changes, 'csp-audit was asked a question it cannot answer').toBeUndefined();
    await expect(row(page, 'changes')).toHaveAttribute('data-dossier-state', 'na');
  });

  test('a real IPAM address is found and shown', async ({ page }) => {
    await page.goto('/#dossier?q=172.16.128.1');
    await expect
      .poll(async () => row(page, 'ipam').getAttribute('data-dossier-state'), { timeout: 60_000 })
      .toBe('ok');
    await expect(row(page, 'ipam')).toContainText('172.16.128.1');
  });

  // Read off the real page, with the query that exposed the defect: a hostname
  // puts IPAM in the na state, so the ribbon cell shows its short label beside
  // the word "N/A" and a truncated label is visible rather than theoretical.
  test('the ribbon carries the mockup’s five short labels', async ({ page }) => {
    await page.goto('/#dossier?q=app-dc1-prod.acme.corp');
    for (const s of SOURCES) {
      const cell = page.locator(`[data-dossier-ribbon="${s}"]`);
      await expect(cell.locator('> span:not([role="img"])').first()).toHaveText(RIBBON_LABELS[s]);
    }
    await expect(page.locator('[data-dossier-ribbon="ipam"]')).toContainText(/IPAM\s*N\/A/);
  });

  test('a real hostname finds its DNS records across zones', async ({ page }) => {
    // Nothing is faked here, so this is also the live half of the IPAM gate:
    // before the gate, this same navigation put a real HTTP 500 in the network
    // log and a red "Unavailable" on the row.
    const ipamStatuses: number[] = [];
    page.on('response', (res) => {
      if (res.url().includes('/api/search/ipam')) ipamStatuses.push(res.status());
    });

    await page.goto('/#dossier?q=app-dc1-prod.acme.corp');
    await expect
      .poll(async () => row(page, 'dns').getAttribute('data-dossier-state'), { timeout: 60_000 })
      .toBe('ok');
    await expect(page.locator('[data-dossier-section="dns"]')).toContainText('app-dc1-prod.acme.corp.');

    await expect(row(page, 'ipam')).toHaveAttribute('data-dossier-state', 'na');
    expect(ipamStatuses, `IPAM was asked and answered ${ipamStatuses.join(', ')}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The ledger's four cell kinds share ONE horizontal inset, and it is a token.
//
// The head cells, the field cells and the threat-intel panel embedded below the
// last row all have to keep one left edge — a single vertical scan of five
// sources is what the ledger is for. That inset was written out four times as
// px-[11px], which is the shape that drifts: fix a misalignment at one and the
// other three stay where they were.
//
// It is --sp-ledger-inset now, and this asserts the RESOLVED px in a browser
// rather than the class name in the source, for the reason tests/chart-tokens.
// spec.ts gives. Three things can go wrong that a source scan cannot see, and
// none of them throws:
//
//   1. the token is not declared, so every var() is invalid at computed-value
//      time and padding falls to its initial 0px;
//   2. Tailwind does not emit a utility for px-[var(--x)] at all, so the class
//      is inert and the cell keeps whatever it inherited;
//   3. one of the four drifts off the token again.
//
// ui/src/lib/spacingRoles.test.js covers (1) and (3) from the source side and
// cannot cover (2) at all, because whether the CSS was generated is a fact
// about the build.
//
// THE TWO FILES CATCH DIFFERENT THINGS, and neither is redundant. Measured, each
// defect injected alone with the tree restored after:
//
//   --sp-ledger-inset undeclared    THIS test fails: "is not declared on :root".
//   the field cells' responsive     THIS test fails, listing 96 cells painting
//   spelling drifts to 14px         14px/14px against the 11px token.
//   `ledger-cell` off the CELL      THIS test fails on the COUNT: "only 5 ledger
//   constant                        cells were found". Without that floor the
//                                   remaining five would all have passed and
//                                   the ninety-six would simply have stopped
//                                   being looked at.
//   one cell back to px-[11px]      THIS TEST PASSES. 11px equals 11px, so
//                                   nothing it can measure has changed. The
//                                   unit test is what fails: "expected 4 uses
//                                   of --sp-ledger-inset, found 3".
//
// The last row is the point. A browser can prove the token RESOLVES; only the
// source can prove all four spellings still ask for it. Delete either file and
// one of those defects ships green.
test('every ledger cell paints the same inset, and it is the token', async ({ page }) => {
  await page.goto('/#dossier?q=172.16.128.1');
  await expect(page.locator('[data-dossier-panel]')).toBeVisible({ timeout: 10_000 });
  // min-[561px] is where the ledger becomes a grid and the field cells pick up
  // this inset. Below that breakpoint they stack and use a narrower padding,
  // which is a different value and deliberately not part of this role — so the
  // viewport is set wide on purpose, and the responsive variant is the half of
  // the role that only gets measured here.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.waitForTimeout(300);

  const seen = await page.evaluate(() => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue('--sp-ledger-inset')
      .trim();
    // Reached through `ledger-cell`, a marker class that styles nothing and
    // exists for exactly this. Selecting by a styling class (div.h-6) couples
    // the guard to how the ledger looks this week; selecting by the words
    // couples it to the copy. Neither reaches the eleven FIELD cells that get
    // their inset through the CELL constant, and those carry the responsive
    // min-[561px]: variant, which is the most fragile of the four spellings.
    const cells = Array.from(document.querySelectorAll('.ledger-cell'));
    const wrong: string[] = [];
    for (const el of cells) {
      const cs = getComputedStyle(el);
      const got = `${cs.paddingLeft}/${cs.paddingRight}`;
      if (got !== `${token}/${token}`) {
        wrong.push(`${(el.className || '').split(' ').slice(0, 3).join(' ')}… paints ${got}`);
      }
    }
    return {
      token,
      wrong,
      count: cells.length,
      // Counted per category, so one cannot vanish behind another's total. The
      // panel is the cell that sits OUTSIDE the grid and still has to line up
      // with it, which is the alignment most easily broken by accident.
      panels: document.querySelectorAll('[data-dossier-panel].ledger-cell').length,
      heads: document.querySelectorAll('.ledger-cell.h-6').length,
    };
  });

  expect(seen.token, '--sp-ledger-inset is not declared on :root').toMatch(/^[\d.]+px$/);
  expect(seen.heads, 'no ledger head cells were found to measure').toBe(4);
  expect(seen.panels, 'the embedded threat-intel panel is not marked as a ledger cell').toBe(1);
  // A floor rather than an exact count: adding or removing a source changes how
  // many field cells the ledger builds, and that must not fail this. What it
  // catches is the field cells not being measured AT ALL, which is what happens
  // if the marker comes off the CELL constant — and they are the only ones
  // carrying the responsive spelling.
  expect(
    seen.count,
    `only ${seen.count} ledger cells were found — the field cells reach their inset through the CELL constant, so a count this low means they are not being measured`,
  ).toBeGreaterThan(10);

  expect(
    seen.wrong,
    `Ledger cells not painting --sp-ledger-inset (${seen.token}):\n  ${seen.wrong.join('\n  ')}`,
  ).toEqual([]);
});
