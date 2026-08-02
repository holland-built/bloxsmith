import { test, expect } from './fixtures';

// Fourth batch of "failure shown as absence" fixes, plus the three
// "unknown shown as zero" ones that ship with them.
//
// Same pattern as failure-not-absence.spec.ts / -2 / -3: stub the same
// endpoint twice — once as a hard failure, once as a genuine empty/ok read —
// and assert the two render different, non-overlapping text. The half that
// actually has teeth is the absence assertion: a build that says "unavailable"
// for everything passes the failure half and fails the genuine-empty half.
//
// The last three describe()s are the other direction of the same lie: a value
// the backend reported as null (util, ttl) or as the literal string "unknown"
// (host status) must not be rendered as a measured 0 / 3600 / "pending". Those
// bodies are crafted here rather than taken from the live tenant so the test
// states the input it is grading.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A hard backend failure: useApi() sets .error and leaves .data null. */
function dead(route: import('@playwright/test').Route) {
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
}

const OK_META = {
  subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
  hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
};

function dataPayload(o: {
  subnets?: unknown[]; leases?: unknown[]; hosts?: unknown[]; zones?: unknown[];
  totals?: Record<string, unknown>; meta?: Record<string, string>;
} = {}) {
  return {
    subnets: o.subnets ?? [],
    leases: o.leases ?? [],
    hosts: o.hosts ?? [],
    zones: o.zones ?? [],
    dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
    _totals: o.totals ?? {},
    _meta: { ...OK_META, ...(o.meta ?? {}) },
  };
}

// None of these specs grade the vault gate, and a transient failure of
// /api/vault/status replaces the whole dashboard with "Vault status
// unavailable" — observed once here against the live dev server. Pinning it
// (same stub failure-not-absence-2.spec.ts uses for its ConnStatus cases)
// keeps that unrelated outage from being read as a panel regression.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
});

// Every Card is a div.bg-card wrapping an h2 title — same ancestor hop the
// SelfService picker specs use.
const CARD = 'xpath=ancestor::div[contains(@class,"bg-card")]';
function card(page: import('@playwright/test').Page, title: string | RegExp) {
  return page.locator('h2', { hasText: title }).first().locator(CARD);
}
/** A KPI row: the label div's parent holds the value beside it. */
function kpi(page: import('@playwright/test').Page, label: string) {
  return page.getByText(label, { exact: true }).locator('..');
}

// ---------- 1. Overview ← /api/data (whole request dead) ----------

test.describe('Overview → subnet/host panels + KPI stack (/api/data down)', () => {
  test('a dead /api/data shows feed-unavailable panels, never a zeroed KPI', async ({ page }) => {
    await page.route('**/api/data*', dead);
    await page.goto('/#overview');

    await expect(page.getByText('Subnets feed unavailable').first()).toBeVisible();
    await expect(page.getByText('Hosts feed unavailable').first()).toBeVisible();

    for (const label of ['Active Leases', 'Subnets (loaded rows)', 'Subnets ≥90% (loaded rows)']) {
      const row = kpi(page, label);
      await expect(row.getByText('unavailable', { exact: true })).toBeVisible();
      await expect(row.getByText('0', { exact: true })).toHaveCount(0);
    }

    const table = card(page, 'Top Subnets by Utilization');
    await expect(table.getByText('— loaded', { exact: true })).toBeVisible();
    await expect(table.getByText('0 loaded', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty tenant still shows real zeros and no unavailable wording', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ meta: { subnets: 'empty', hosts: 'empty', leases: 'empty' } })),
    );
    await page.goto('/#overview');

    for (const label of ['Active Leases', 'Subnets (loaded rows)', 'Subnets ≥90% (loaded rows)']) {
      const row = kpi(page, label);
      await expect(row.getByText('0', { exact: true })).toBeVisible();
      await expect(row.getByText('unavailable', { exact: true })).toHaveCount(0);
    }

    const table = card(page, 'Top Subnets by Utilization');
    await expect(table.getByText('0 loaded', { exact: true })).toBeVisible();
    await expect(page.getByText('Subnets feed unavailable')).toHaveCount(0);
    await expect(page.getByText('Hosts feed unavailable')).toHaveCount(0);
  });
});

// ---------- 2. Network ← /api/data ----------

test.describe('Network → Utilization Distribution + exhaustion table (/api/data down)', () => {
  test('a dead /api/data shows "Subnets feed unavailable" and "— loaded", not "0 loaded"', async ({ page }) => {
    await page.route('**/api/data*', dead);
    await page.goto('/#network');

    const bands = card(page, 'Utilization Distribution');
    await expect(bands.getByText('Subnets feed unavailable')).toBeVisible();
    await expect(bands.getByText('— loaded (count unavailable)', { exact: true })).toBeVisible();
    await expect(bands.getByText(/\b0 loaded\b/)).toHaveCount(0);

    const exhaustion = card(page, 'Which Subnets Run Out First?');
    await expect(exhaustion.getByText('Subnets feed unavailable')).toBeVisible();
    await expect(exhaustion.locator('tbody tr')).toHaveCount(0);
  });

  test('a genuinely empty tenant still shows "0 loaded of 0 total"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ totals: { subnets: 0 }, meta: { subnets: 'empty' } })),
    );
    await page.goto('/#network');

    const bands = card(page, 'Utilization Distribution');
    await expect(bands.getByText('0 loaded of 0 total', { exact: true })).toBeVisible();
    await expect(bands.getByText('Subnets feed unavailable')).toHaveCount(0);
    await expect(bands.getByText('— loaded (count unavailable)', { exact: true })).toHaveCount(0);
  });
});

// ---------- 3. Infra ← /api/data ----------

test.describe('Infra → Host Status + Host Inventory (/api/data down)', () => {
  test('a dead /api/data shows "Hosts feed unavailable" and "— hosts", not "0 hosts"', async ({ page }) => {
    await page.route('**/api/data*', dead);
    await page.goto('/#infra');

    await expect(card(page, 'Host Status').getByText('Hosts feed unavailable')).toBeVisible();

    const inventory = card(page, 'Host Inventory');
    await expect(inventory.getByText('Hosts feed unavailable')).toBeVisible();
    await expect(inventory.getByText('— hosts', { exact: true })).toBeVisible();
    await expect(inventory.getByText('0 hosts', { exact: true })).toHaveCount(0);
    await expect(inventory.locator('tbody tr')).toHaveCount(0);
  });

  test('a genuinely empty tenant still shows "0 hosts"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ meta: { hosts: 'empty' } })),
    );
    await page.goto('/#infra');

    const inventory = card(page, 'Host Inventory');
    await expect(inventory.getByText('0 hosts', { exact: true })).toBeVisible();
    await expect(inventory.getByText('— hosts', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Hosts feed unavailable')).toHaveCount(0);
  });
});

// ---------- 4. Daily ← /api/data ----------

test.describe('Daily → Hosts Needing Attention / capacity / zones (/api/data down)', () => {
  test('a dead /api/data never says "all hosts online" and prints no 0 counts', async ({ page }) => {
    await page.route('**/api/data*', dead);
    await page.goto('/#daily');

    await expect(page.getByText('all hosts online')).toHaveCount(0);
    await expect(page.getByText('no DNS zone issues')).toHaveCount(0);

    const hosts = card(page, 'Hosts Needing Attention');
    await expect(hosts.getByText('Hosts feed unavailable')).toBeVisible();
    await expect(hosts.getByText('— shown', { exact: true })).toBeVisible();
    await expect(hosts.getByText('0 shown', { exact: true })).toHaveCount(0);

    const zones = card(page, 'DNS Zone Issues');
    await expect(zones.getByText('DNS zones feed unavailable')).toBeVisible();
    await expect(zones.getByText('— zones', { exact: true })).toBeVisible();
    await expect(zones.getByText('0 zones', { exact: true })).toHaveCount(0);

    await expect(card(page, 'Top Capacity Risks').getByText('Subnets feed unavailable')).toBeVisible();

    for (const label of ['Subnets >85% Util', 'Hosts Not Online', 'DNS Zones w/ Issues']) {
      const row = kpi(page, label);
      await expect(row.getByText('unavailable', { exact: true })).toBeVisible();
      await expect(row.getByText('0', { exact: true })).toHaveCount(0);
    }
  });

  test('a genuinely empty tenant still says "all hosts online" and 0 counts', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ meta: { subnets: 'empty', hosts: 'empty', zones: 'empty' } })),
    );
    await page.goto('/#daily');

    const hosts = card(page, 'Hosts Needing Attention');
    await expect(hosts.getByText('all hosts online')).toBeVisible();
    await expect(hosts.getByText('0 shown', { exact: true })).toBeVisible();
    await expect(hosts.getByText('Hosts feed unavailable')).toHaveCount(0);

    const zones = card(page, 'DNS Zone Issues');
    await expect(zones.getByText('no DNS zone issues')).toBeVisible();
    await expect(zones.getByText('0 zones', { exact: true })).toBeVisible();

    for (const label of ['Subnets >85% Util', 'Hosts Not Online', 'DNS Zones w/ Issues']) {
      const row = kpi(page, label);
      await expect(row.getByText('0', { exact: true })).toBeVisible();
      await expect(row.getByText('unavailable', { exact: true })).toHaveCount(0);
    }
  });
});

// ---------- 5. Incidents ← /api/incidents ----------

test.describe('Incidents → severity tiles + categories (/api/incidents down)', () => {
  const CLEAN = {
    incidents: [], snoozes: {}, signals: [], signals_total: 0, signals_truncated: false,
    _meta: { subnets: 'ok', zones: 'ok', leases: 'ok' }, signals_degraded: false,
  };

  test('a dead /api/incidents shows em-dashes, never "Critical 0 High 0 Medium 0 Low 0"', async ({ page }) => {
    await page.route('**/api/incidents*', dead);
    await page.goto('/#incidents');

    const sev = page.getByText('Severity counts unavailable').locator(CARD);
    await expect(sev).toBeVisible();
    for (const label of ['Critical', 'High', 'Medium', 'Low']) {
      const cell = sev.getByText(label, { exact: true }).locator('..');
      await expect(cell.getByText('—', { exact: true })).toBeVisible();
      await expect(cell.getByText('0', { exact: true })).toHaveCount(0);
    }

    const cats = card(page, 'Categories');
    await expect(cats.getByText('Categories unavailable')).toBeVisible();
    await expect(cats.getByText('no active categories')).toHaveCount(0);
  });

  test('a genuinely clean read still shows real zeros and "no active categories"', async ({ page }) => {
    await page.route('**/api/incidents*', (route) => fulfillJson(route, CLEAN));
    await page.goto('/#incidents');

    for (const label of ['Critical', 'High', 'Medium', 'Low']) {
      const cell = page.getByText(label, { exact: true }).first().locator('..');
      await expect(cell.getByText('0', { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Severity counts unavailable')).toHaveCount(0);

    const cats = card(page, 'Categories');
    await expect(cats.getByText('no active categories')).toBeVisible();
    await expect(cats.getByText('Categories unavailable')).toHaveCount(0);
  });
});

// ---------- 6. Daily → Security Today ← /api/hub/security ----------

test.describe('Daily → Security Today (/api/hub/security down)', () => {
  const EMPTY_OK = {
    events: [], counts: { critical: 0, high: 0, medium: 0, low: 0 },
    blocked: 0, logged: 0, total: 0, availability: 'ok',
  };

  test('a 500 shows the unavailable state and "— events", not "0 events"', async ({ page }) => {
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload()));
    await page.route('**/api/hub/security*', dead);
    await page.goto('/#daily');

    const sec = card(page, 'Security Today');
    await expect(sec.getByText('Threat feed unavailable')).toBeVisible();
    await expect(sec.getByText('— events', { exact: true })).toBeVisible();
    await expect(sec.getByText('0 events', { exact: true })).toHaveCount(0);
    await expect(sec.getByText('critical', { exact: true })).toHaveCount(0);
  });

  test('a genuinely quiet day still shows the zeroed chip grid and "0 events"', async ({ page }) => {
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload()));
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#daily');

    const sec = card(page, 'Security Today');
    await expect(sec.getByText('0 events', { exact: true })).toBeVisible();
    await expect(sec.getByText('critical', { exact: true })).toBeVisible();
    await expect(sec.getByText('Threat feed unavailable')).toHaveCount(0);
  });
});

// ---------- 7. Security → Exposures + Lookalike Domains ----------

test.describe('Security → Exposures + Lookalike Domains (failed fetch)', () => {
  test('failed fetches never say "no exposures reported" or "0 detected"', async ({ page }) => {
    await page.route('**/api/csp/exposures*', dead);
    await page.route('**/api/lookalikes*', dead);
    await page.goto('/#security');

    const exposures = card(page, 'Exposures');
    await expect(exposures.getByText('Exposures feed unavailable')).toBeVisible();
    await expect(exposures.getByText('no exposures reported')).toHaveCount(0);

    const lookalikes = card(page, 'Lookalike Domains');
    await expect(lookalikes.getByText('Lookalike domain feed unavailable')).toBeVisible();
    await expect(lookalikes.getByText('— detected', { exact: true })).toBeVisible();
    await expect(lookalikes.getByText('0 detected', { exact: true })).toHaveCount(0);
  });

  test('genuinely empty reads still say "no exposures reported" and "0 detected"', async ({ page }) => {
    await page.route('**/api/csp/exposures*', (route) =>
      fulfillJson(route, { availability: 'ok', data: { rows: [], count: 0, total_available: 0 } }),
    );
    await page.route('**/api/lookalikes*', (route) => fulfillJson(route, { domains: [], targets: [] }));
    await page.goto('/#security');

    const exposures = card(page, 'Exposures');
    await expect(exposures.getByText('no exposures reported')).toBeVisible();
    await expect(exposures.getByText('Exposures feed unavailable')).toHaveCount(0);

    const lookalikes = card(page, 'Lookalike Domains');
    await expect(lookalikes.getByText('0 detected', { exact: true })).toBeVisible();
    await expect(lookalikes.getByText('— detected', { exact: true })).toHaveCount(0);
    await expect(lookalikes.getByText('Lookalike domain feed unavailable')).toHaveCount(0);
  });
});

// ---------- 8. A subnet with util:null is not a healthy 0% subnet ----------

test.describe('Network → exhaustion table (subnet with util:null)', () => {
  const SUBNETS = [
    { id: 'a', name: 'unmeasured', addr: '10.9.0.0', cidr: 24, total: null, used: null, util: null, site: 'lab' },
    { id: 'b', name: 'measured', addr: '10.9.1.0', cidr: 24, total: 256, used: 128, util: 50, site: 'lab' },
  ];

  test('an unreported utilisation renders "—" and an Unknown pill, never 0% / Healthy', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ subnets: SUBNETS, totals: { subnets: 2 } })),
    );
    await page.goto('/#network');

    const table = card(page, 'Which Subnets Run Out First?');
    const unmeasured = table.locator('tbody tr', { hasText: '10.9.0.0' });
    await expect(unmeasured.getByText('—', { exact: true })).toHaveCount(3); // util, used, free
    await expect(unmeasured.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(unmeasured.getByText('Healthy', { exact: true })).toHaveCount(0);
    await expect(unmeasured.getByText('0%', { exact: true })).toHaveCount(0);

    // The measured row proves the Unknown pill is not simply painted on every
    // row: a subnet that WAS measured still gets its real number and grade.
    const measured = table.locator('tbody tr', { hasText: '10.9.1.0' });
    await expect(measured.getByText('50%', { exact: true })).toBeVisible();
    await expect(measured.getByText('Healthy', { exact: true })).toBeVisible();
    await expect(measured.getByText('Unknown', { exact: true })).toHaveCount(0);
  });
});

// ---------- 9. A zone with ttl:null is not a checked, clean zone ----------

test.describe('DNS → zone table (zone with ttl:null)', () => {
  const ZONES = [
    { fqdn: 'no-authority.example.com', view: 'default', records: 4, ttl: null, neg_ttl: null, issues: null, anomaly: null },
    { fqdn: 'checked.example.com', view: 'default', records: 7, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false },
    // A third, genuinely-flagged zone: DataTable auto-hides a column whose
    // non-empty cells are all identical, so a two-row fixture would drop the
    // Issues column entirely and the assertions below would grade nothing.
    { fqdn: 'lowttl.example.com', view: 'default', records: 2, ttl: 30, neg_ttl: 900, issues: ['TTL Too Low'], anomaly: false },
  ];

  test('an unpublished TTL renders "—" and is not counted as a checked zone', async ({ page }) => {
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({ zones: ZONES })));
    await page.goto('/#dns');

    const table = card(page, /^DNS Zones$/);
    // Column order is Zone / View / Records / TTL / Issues — asserted by index
    // because "the TTL cell says —" and "some cell in this row says —" are
    // different claims, and only the first one is the fix.
    await expect(table.getByRole('columnheader', { name: 'TTL' })).toBeVisible();
    const unknown = table.locator('tbody tr', { hasText: 'no-authority.example.com' });
    await expect(unknown.locator('td').nth(3)).toHaveText('—');
    await expect(unknown.getByText('not checked', { exact: true })).toBeVisible();
    // 3600 was the invented default this fix removed.
    await expect(unknown.getByText('3600', { exact: true })).toHaveCount(0);

    const checked = table.locator('tbody tr', { hasText: 'checked.example.com' });
    await expect(checked.getByText('3600', { exact: true })).toBeVisible();
    await expect(checked.getByText('not checked', { exact: true })).toHaveCount(0);

    // The verdict tiles must name the population they actually cover: 2 zones,
    // only 1 of them examined.
    const kpis = page.getByText('Zones w/ issues', { exact: true }).locator(CARD);
    await expect(kpis.getByText('1 publish no TTL', { exact: true })).toBeVisible();
    await expect(kpis.getByText('of 2 checked', { exact: true }).first()).toBeVisible();
  });
});

// ---------- 10. A host reported as "unknown" is not "pending" ----------

test.describe('Infra → host inventory (host with status "unknown")', () => {
  const HOSTS = [
    { id: 'h1', name: 'nostatus-host', ip: '10.8.0.1', status: 'unknown', type: 'bloxone' },
    { id: 'h2', name: 'pending-host', ip: '10.8.0.2', status: 'pending', type: 'bloxone' },
  ];

  test('an unknown status gets its own badge and is never labelled "pending"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ hosts: HOSTS, totals: { hosts: 2 } })),
    );
    await page.goto('/#infra');

    const inventory = card(page, 'Host Inventory');
    const unknownRow = inventory.locator('tbody tr', { hasText: 'nostatus-host' });
    // Its OWN badge — the generic status pill carries no explanation, so the
    // tooltip is what separates "we were not told" from any lifecycle state.
    await expect(
      unknownRow.locator('[title="upstream reported no status for this host"]'),
    ).toHaveText('unknown');
    await expect(unknownRow.getByText('pending', { exact: true })).toHaveCount(0);

    const pendingRow = inventory.locator('tbody tr', { hasText: 'pending-host' });
    await expect(pendingRow.getByText('pending', { exact: true })).toBeVisible();
    await expect(pendingRow.getByText('unknown', { exact: true })).toHaveCount(0);

    // The donut breaks Unknown out into its own slice rather than burying the
    // unreported host inside the Other bucket alongside the pending one.
    const status = card(page, 'Host Status');
    await expect(status.getByText('Unknown', { exact: true })).toBeVisible();
    const other = status.getByText('Other', { exact: true }).locator('..');
    await expect(other.getByText('100%', { exact: true })).toHaveCount(0);
    await expect(other.getByText('50%', { exact: true })).toBeVisible();
  });
});
