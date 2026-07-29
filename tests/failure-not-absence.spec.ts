import { test, expect } from '@playwright/test';

// Seven panels across five tabs used to render a backend-reported FAILURE
// (an explicit availability/status/signals_degraded flag) identically to a
// genuine empty read — "0 events", "no pending actions", "no issues
// detected", "No matches", "not entitled", "no DNSSEC data" all looked the
// same whether the feed was dead or just quiet. Each block below stubs the
// same endpoint twice — once as a hard failure, once as a genuine empty/ok
// read — and asserts the two render different, non-overlapping text.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function dataPayload(overrides: {
  hosts?: unknown[];
  subnets?: unknown[];
  zones?: unknown[];
  meta: Record<string, string>;
}) {
  return {
    subnets: overrides.subnets ?? [],
    leases: [],
    hosts: overrides.hosts ?? [],
    zones: overrides.zones ?? [],
    dnsViews: [],
    secPolicies: [],
    feeds: [],
    auditLogs: [],
    _totals: {},
    _meta: {
      subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
      hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
      ...overrides.meta,
    },
  };
}

// ---------- 1. Daily → Security Today (hub/security availability) ----------

test.describe('Daily → Security Today panel (threat-event feed)', () => {
  const DEAD = {
    events: [], counts: { critical: 0, high: 0, medium: 0, low: 0 }, blocked: 0, logged: 0, total: 0,
    availability: 'unavailable', reason: 'threat-event feed unavailable',
  };
  const EMPTY_OK = {
    events: [], counts: { critical: 0, high: 0, medium: 0, low: 0 }, blocked: 0, logged: 0, total: 0,
    availability: 'ok',
  };

  test('dead feed shows unavailable wording, not zeroed chips', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, DEAD));
    await page.goto('/#daily');
    const card = page.locator('text=Security Today').locator('..').locator('..');
    await expect(card.getByText(/threat feed unavailable/i)).toBeVisible();
    await expect(card.getByText('critical', { exact: true })).toHaveCount(0);
  });

  test('genuinely empty feed still renders the zeroed chip grid', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#daily');
    const card = page.locator('text=Security Today').locator('..').locator('..');
    await expect(card.getByText(/threat feed unavailable/i)).toHaveCount(0);
    await expect(card.getByText('critical', { exact: true })).toBeVisible();
  });
});

// ---------- 2. Daily → Open Issues (per-feed _meta on IssueKpis) ----------

test.describe('Daily → Open Issues panel (hosts feed, one of three KPI rows)', () => {
  test('hosts feed error shows "unavailable" on that row only, not a 0 count', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ hosts: [], meta: { hosts: 'error' } })),
    );
    await page.goto('/#daily');
    const card = page.locator('text=Open Issues').locator('..').locator('..');
    const hostsRow = card.getByText('Hosts Not Online', { exact: true }).locator('..');
    await expect(hostsRow.getByText('unavailable', { exact: true })).toBeVisible();
    await expect(hostsRow.getByText('0', { exact: true })).toHaveCount(0);
  });

  test('hosts feed empty shows a real 0, not "unavailable"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ hosts: [], meta: { hosts: 'empty' } })),
    );
    await page.goto('/#daily');
    const card = page.locator('text=Open Issues').locator('..').locator('..');
    const hostsRow = card.getByText('Hosts Not Online', { exact: true }).locator('..');
    await expect(hostsRow.getByText('unavailable', { exact: true })).toHaveCount(0);
    await expect(hostsRow.getByText('0', { exact: true })).toBeVisible();
  });
});

// ---------- 3. Incidents → SOC Queue (FetchActions availability) ----------

test.describe('Incidents → SOC Queue panel (IQ Actions feed)', () => {
  const DEAD = { actions: [], unavailable: 'IQ Actions service unavailable (upstream error).', availability: 'unavailable' };
  const EMPTY_OK = { actions: [], unavailable: 'No IQ Actions (SOC incidents) for this tenant.', availability: 'ok' };

  test('dead feed shows unavailable wording, not "no pending actions"', async ({ page }) => {
    await page.route('**/api/actions*', (route) => fulfillJson(route, DEAD));
    await page.goto('/#incidents');
    const card = page.locator('text=SOC Queue').locator('..').locator('..');
    await expect(card.getByText(/iq actions feed unavailable/i)).toBeVisible();
    await expect(card.getByText(/no pending actions/i)).toHaveCount(0);
  });

  test('genuinely empty tenant still renders "no pending actions"', async ({ page }) => {
    await page.route('**/api/actions*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#incidents');
    const card = page.locator('text=SOC Queue').locator('..').locator('..');
    await expect(card.getByText(/no pending actions/i)).toBeVisible();
    await expect(card.getByText(/iq actions feed unavailable/i)).toHaveCount(0);
  });
});

// ---------- 4. Incidents → Triage (signals_degraded) ----------

test.describe('Incidents → Triage panel (signals_degraded)', () => {
  const DEGRADED = {
    incidents: [], snoozes: {}, signals: [], signals_total: 0, signals_truncated: false,
    _meta: { subnets: 'error', zones: 'ok', leases: 'ok' }, signals_degraded: true,
  };
  const CLEAN = {
    incidents: [], snoozes: {}, signals: [], signals_total: 0, signals_truncated: false,
    _meta: { subnets: 'ok', zones: 'ok', leases: 'ok' }, signals_degraded: false,
  };

  test('degraded read never claims metrics are within normal thresholds', async ({ page }) => {
    await page.route('**/api/incidents*', (route) => fulfillJson(route, DEGRADED));
    await page.goto('/#incidents');
    const card = page.locator('text=Triage').locator('..').locator('..');
    await expect(card.getByText(/check could not be completed/i)).toBeVisible();
    await expect(card.getByText(/no issues detected/i)).toHaveCount(0);
  });

  test('a genuinely clean read still renders the all-clear message', async ({ page }) => {
    await page.route('**/api/incidents*', (route) => fulfillJson(route, CLEAN));
    await page.goto('/#incidents');
    const card = page.locator('text=Triage').locator('..').locator('..');
    await expect(card.getByText(/no issues detected — all metrics within normal thresholds/i)).toBeVisible();
    await expect(card.getByText(/check could not be completed/i)).toHaveCount(0);
  });
});

// ---------- 5. AI → Threat lookup (ThreatLookup availability) ----------

test.describe('AI → Threat lookup panel (network_entity_search)', () => {
  const DEAD = {
    entities: [], query: 'evil.example.com', availability: 'unavailable',
    reason: 'Entity search (network_entity_search) unavailable (upstream error).',
  };
  const EMPTY_OK = { entities: [], query: 'benign.example.com', availability: 'ok' };

  test('a failed search shows unavailable wording, not "No matches"', async ({ page }) => {
    await page.route('**/api/dossier*', (route) => fulfillJson(route, {}));
    await page.route('**/api/threat-lookup*', (route) => fulfillJson(route, DEAD));
    await page.goto('/#ai');
    const card = page.locator('text=Threat lookup').locator('..').locator('..');
    await card.getByPlaceholder('domain, IP, or host…').fill('evil.example.com');
    await card.getByRole('button', { name: 'Lookup', exact: true }).click();
    await expect(card.getByText(/threat lookup unavailable/i)).toBeVisible();
    await expect(card.getByText(/no matches/i)).toHaveCount(0);
  });

  test('a genuine no-match search still renders "No matches"', async ({ page }) => {
    await page.route('**/api/dossier*', (route) => fulfillJson(route, {}));
    await page.route('**/api/threat-lookup*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#ai');
    const card = page.locator('text=Threat lookup').locator('..').locator('..');
    await card.getByPlaceholder('domain, IP, or host…').fill('benign.example.com');
    await card.getByRole('button', { name: 'Lookup', exact: true }).click();
    await expect(card.getByText(/no matches/i)).toBeVisible();
    await expect(card.getByText(/threat lookup unavailable/i)).toHaveCount(0);
  });
});

// ---------- 6. Security → Lookalike Domains (not_entitled vs plain outage) ----------

test.describe('Security → Lookalike Domains panel (not_entitled vs plain outage)', () => {
  const NOT_ENTITLED = { domains: [], targets: [], unavailable: 'Lookalike Domains not entitled', not_entitled: true };
  const PLAIN_OUTAGE = { domains: [], targets: [], unavailable: 'Lookalike Domains service unavailable', not_entitled: false };
  const GENUINE_EMPTY = { domains: [], targets: [], unavailable: null };

  test('a 403 entitlement failure renders entitlement wording', async ({ page }) => {
    await page.route('**/api/lookalikes*', (route) => fulfillJson(route, NOT_ENTITLED));
    await page.goto('/#security');
    const card = page.locator('text=Lookalike Domains').locator('..').locator('..');
    await expect(card.getByText(/not entitled — Lookalike Domains not entitled/i)).toBeVisible();
  });

  test('a plain outage (not a 403) never claims "not entitled"', async ({ page }) => {
    await page.route('**/api/lookalikes*', (route) => fulfillJson(route, PLAIN_OUTAGE));
    await page.goto('/#security');
    const card = page.locator('text=Lookalike Domains').locator('..').locator('..');
    await expect(card.getByText('Lookalike Domains service unavailable', { exact: true })).toBeVisible();
    await expect(card.getByText(/not entitled/i)).toHaveCount(0);
  });

  test('a genuinely empty tenant renders the ordinary empty state', async ({ page }) => {
    await page.route('**/api/lookalikes*', (route) => fulfillJson(route, GENUINE_EMPTY));
    await page.goto('/#security');
    const card = page.locator('text=Lookalike Domains').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/not entitled/i)).toHaveCount(0);
  });
});

// ---------- 7. DNS → DNSSEC Health (CSP tile status:"error" at HTTP 200) ----------

test.describe('DNS → DNSSEC Health panel (CSPDnssec status field)', () => {
  test('status:"error" renders unavailable wording, not "no DNSSEC data"', async ({ page }) => {
    await page.route('**/api/csp/dnssec*', (route) => fulfillJson(route, { rows: [], count: 0, status: 'error' }));
    await page.goto('/#dns');
    const card = page.locator('text=DNSSEC Health').locator('..').locator('..');
    await expect(card.getByText(/dnssec feed unavailable/i)).toBeVisible();
    await expect(card.getByText(/no dnssec data/i)).toHaveCount(0);
  });

  test('a genuinely empty response renders "no DNSSEC data"', async ({ page }) => {
    await page.route('**/api/csp/dnssec*', (route) => fulfillJson(route, { rows: [], count: 0, status: 'ok' }));
    await page.goto('/#dns');
    const card = page.locator('text=DNSSEC Health').locator('..').locator('..');
    await expect(card.getByText(/no dnssec data/i)).toBeVisible();
    await expect(card.getByText(/dnssec feed unavailable/i)).toHaveCount(0);
  });
});
