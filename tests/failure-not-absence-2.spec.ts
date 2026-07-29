import { test, expect } from '@playwright/test';

// Second batch of "failure shown as absence" fixes. Same pattern as
// failure-not-absence.spec.ts: stub the same endpoint twice — once as a hard
// failure (non-2xx, an explicit error/status field, or a transport error),
// once as a genuine empty/ok read — and assert the two render different,
// non-overlapping text. Genuine-empty wording must stay exactly as it was.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// ---------- 1. AI → Dossier (a 503 must never paint a false CLEAN verdict) ----------

test.describe('AI → Threat lookup dossier (DossierPanel + Ai.jsx fetch)', () => {
  const VAULT_LOCKED_503 = { error: 'vault locked', locked: true };
  const GENUINE_CLEAN = {
    summary: { malicious: false },
    sources: [],
    query: 'benign.example.com',
    type: 'domain',
  };

  test('a 503 vault-locked body never shows a CLEAN pill', async ({ page }) => {
    await page.route('**/api/dossier*', (route) => fulfillJson(route, VAULT_LOCKED_503, 503));
    await page.route('**/api/threat-lookup*', (route) => fulfillJson(route, { entities: [], availability: 'ok' }));
    await page.goto('/#ai');
    const card = page.locator('text=Threat lookup').locator('..').locator('..');
    await card.getByPlaceholder('domain, IP, or host…').fill('evil.example.com');
    await card.getByRole('button', { name: 'Lookup', exact: true }).click();
    await expect(card.getByText('Dossier unavailable', { exact: true })).toBeVisible();
    await expect(card.getByText('CLEAN', { exact: true })).toHaveCount(0);
    await expect(card.getByText('MALICIOUS', { exact: true })).toHaveCount(0);
  });

  test('a genuine clean lookup still renders the CLEAN pill', async ({ page }) => {
    await page.route('**/api/dossier*', (route) => fulfillJson(route, GENUINE_CLEAN));
    await page.route('**/api/threat-lookup*', (route) => fulfillJson(route, { entities: [], availability: 'ok' }));
    await page.goto('/#ai');
    const card = page.locator('text=Threat lookup').locator('..').locator('..');
    await card.getByPlaceholder('domain, IP, or host…').fill('benign.example.com');
    await card.getByRole('button', { name: 'Lookup', exact: true }).click();
    await expect(card.getByText('CLEAN', { exact: true })).toBeVisible();
    await expect(card.getByText('Dossier unavailable', { exact: true })).toHaveCount(0);
  });
});

// ---------- 2. Security → SOC Insights (FetchInsights availability) ----------

test.describe('Security → SOC Insights panel (InsightsPanel)', () => {
  const DEAD = { data: [], unavailable: 'SOC insights feed unavailable (upstream error).', availability: 'error' };
  const EMPTY_OK = { data: [], availability: 'ok' };

  test('dead feed shows unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/insights*', (route) => fulfillJson(route, DEAD));
    await page.goto('/#security');
    const card = page.locator('text=SOC Insights').locator('..').locator('..');
    await expect(card.getByText(/soc insights unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('a genuinely empty tenant still renders "no data"', async ({ page }) => {
    await page.route('**/api/insights*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#security');
    const card = page.locator('text=SOC Insights').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/soc insights unavailable/i)).toHaveCount(0);
  });
});

// ---------- 3. Security → Threat Feed Activity (status:"error" folded into Empty) ----------

test.describe('Security → Threat Feed Activity panel', () => {
  test('status:"error" shows unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/csp/threats*', (route) => fulfillJson(route, { rows: [], status: 'error' }));
    await page.goto('/#security');
    const card = page.locator('text=Threat Feed Activity').locator('..').locator('..');
    await expect(card.getByText(/threat feed activity unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('a genuinely empty response still renders "no data"', async ({ page }) => {
    await page.route('**/api/csp/threats*', (route) => fulfillJson(route, { rows: [], status: 'ok' }));
    await page.goto('/#security');
    const card = page.locator('text=Threat Feed Activity').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/threat feed activity unavailable/i)).toHaveCount(0);
  });
});

// ---------- 4. Security → Threat Events by Severity (transport failure, not just availability) ----------

test.describe('Security → Threat Events by Severity panel (hub.error transport path)', () => {
  const EMPTY_OK = {
    events: [], counts: { critical: 0, high: 0, medium: 0, low: 0 }, blocked: 0, logged: 0, total: 0,
    availability: 'ok',
  };

  test('a non-2xx transport failure shows unavailable wording and no zeroed count', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto('/#security');
    const card = page.locator('text=Threat Events — by Severity').locator('..').locator('..');
    await expect(card.getByText(/threat feed unavailable/i)).toBeVisible();
    await expect(card.getByText('0 events', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty read still renders the real "0 events" count', async ({ page }) => {
    await page.route('**/api/hub/security*', (route) => fulfillJson(route, EMPTY_OK));
    await page.goto('/#security');
    const card = page.locator('text=Threat Events — by Severity').locator('..').locator('..');
    await expect(card.getByText('0 events', { exact: true })).toBeVisible();
    await expect(card.getByText(/threat feed unavailable/i)).toHaveCount(0);
  });
});

// ---------- 5. Topbar → ConnStatus pill (degraded feed vs genuinely empty tenant) ----------

test.describe('Topbar connection pill (ConnStatus _meta / _totals.degraded)', () => {
  function dataPayload(meta: Record<string, string>, degraded: boolean) {
    return {
      subnets: [], leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
      _totals: { degraded },
      _meta: { subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok', hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok', ...meta },
    };
  }

  test('an all-error/degraded payload shows "feed error", not "no data"', async ({ page }) => {
    await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({ hosts: 'error', subnets: 'error', leases: 'error' }, true)));
    await page.goto('/#overview');
    const pill = page.locator('span[title*="last data fetch"]');
    await expect(pill).toContainText('feed error');
    await expect(pill).not.toContainText('no data');
  });

  test('a genuinely empty tenant still shows "no data"', async ({ page }) => {
    await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({}, false)));
    await page.goto('/#overview');
    const pill = page.locator('span[title*="last data fetch"]');
    await expect(pill).toContainText('no data');
    await expect(pill).not.toContainText('feed error');
  });
});

// ---------- 6. Overview → License Inventory (status:"error" + a header count that isn't real) ----------

test.describe('Overview → License Inventory panel', () => {
  test('status:"error" shows unavailable wording, not a "0 licenses" header count', async ({ page }) => {
    await page.route('**/api/csp/license-alerts*', (route) => fulfillJson(route, { licenses: [], status: 'error' }));
    await page.goto('/#overview');
    const card = page.locator('text=License Inventory').locator('..').locator('..');
    await expect(card.getByText(/license feed unavailable/i)).toBeVisible();
    await expect(card.getByText('0 licenses', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty tenant still renders "no license data available" and a real 0 count', async ({ page }) => {
    await page.route('**/api/csp/license-alerts*', (route) => fulfillJson(route, { licenses: [], status: 'ok' }));
    await page.goto('/#overview');
    const card = page.locator('text=License Inventory').locator('..').locator('..');
    await expect(card.getByText(/no license data available/i)).toBeVisible();
    await expect(card.getByText('0 licenses', { exact: true })).toBeVisible();
    await expect(card.getByText(/license feed unavailable/i)).toHaveCount(0);
  });
});

// ---------- 7. VaultGate (a failed /api/vault/status read must not open the dashboard) ----------

test.describe('VaultGate (failed vault status read)', () => {
  test('a failed status read shows unavailable wording, not the full dashboard', async ({ page }) => {
    await page.route('**/api/vault/status*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto('/');
    await expect(page.getByText(/vault status unavailable/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Overview' })).toHaveCount(0);
  });

  test('a genuine successful status read still opens the dashboard', async ({ page }) => {
    await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText(/vault status unavailable/i)).toHaveCount(0);
  });
});
