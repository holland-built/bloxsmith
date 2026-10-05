import { test, expect } from './fixtures';

// The headline strips on the Estate tabs (Network, DNS, Infra, Assets).
// Each number is a jump to a panel, so it must agree with that panel, and a
// feed that is down is a dash, never a zero.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function dead(route: import('@playwright/test').Route) {
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
}

const OK_META = {
  subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
  hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
};

function dataPayload(o: { subnets?: unknown[]; hosts?: unknown[]; zones?: unknown[]; totals?: Record<string, unknown> } = {}) {
  return {
    subnets: o.subnets ?? [], leases: [], hosts: o.hosts ?? [], zones: o.zones ?? [],
    dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
    _totals: o.totals ?? {}, _meta: OK_META,
  };
}

/** The strip's button for one headline, found by the start of its label. */
function headline(page: import('@playwright/test').Page, label: RegExp) {
  return page.getByRole('list', { name: 'Headline numbers' }).getByRole('button', { name: label });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
});

test('Network: the band counts are the chart\'s own bands, from the same rows', async ({ page }) => {
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({
    subnets: [
      { id: 'a', addr: '10.0.0.0', cidr: 24, total: 256, used: 233, util: 91 },
      { id: 'b', addr: '10.0.1.0', cidr: 24, total: 256, used: 225, util: 88 },
      { id: 'c', addr: '10.0.2.0', cidr: 24, total: 256, used: 184, util: 72 },
      { id: 'd', addr: '10.0.3.0', cidr: 24, total: 256, used: 128, util: 50 },
    ],
    totals: { subnets: 40, subnetsCrit: 1, subnetsWarn: 3 },
  })));
  await page.goto('/#network');
  await expect(headline(page, /^Subnets 40$/)).toBeVisible();
  // 91 is 90 or more; 88 and 72 are in 70–89, as the chart draws them. 88 is
  // the one that moved: it was "over 85", and red, until 2026-10-04.
  await expect(headline(page, /^≥90% 1$/)).toBeVisible();
  await expect(headline(page, /^70–89% 2$/)).toBeVisible();
});

test('Network: when the server capped its at-risk read, the bands say they count loaded rows', async ({ page }) => {
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({
    subnets: [{ id: 'a', addr: '10.0.0.0', cidr: 24, total: 256, used: 233, util: 91 }],
    // The estate has 5 subnets at 70% or more; only one of them was loaded.
    totals: { subnets: 40, subnetsCrit: 3, subnetsWarn: 5, degraded: true },
  })));
  await page.goto('/#network');
  await expect(headline(page, /^≥90% \(of loaded\) 1$/)).toBeVisible();
  await expect(headline(page, /^70–89% \(of loaded\) 0$/)).toBeVisible();
});

test('Network, DNS, Infra: a dead /api/data is a dash in the strip, never 0', async ({ page }) => {
  await page.route('**/api/data*', dead);
  for (const [tab, labels] of [
    ['network', [/^Subnets/, /^≥90%/, /^70–89%/]],
    ['dns', [/^Zones [—0-9]/, /^Zones with issues/]],
    ['infra', [/^Hosts/, /^Offline/, /^Degraded/, /^Unknown/]],
  ] as const) {
    await page.goto(`/#${tab}`);
    for (const label of labels) {
      await expect(headline(page, label)).toContainText('—');
      await expect(headline(page, label)).not.toContainText(/\b0\b/);
    }
  }
});

test('DNS: zones never run through the checks are named, not counted as clean', async ({ page }) => {
  await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload({
    zones: [
      { id: 'z1', fqdn: 'a.example.', issues: ['High Neg-TTL'] },
      { id: 'z2', fqdn: 'b.example.', issues: [] },
      { id: 'z3', fqdn: 'c.example.' }, // publishes no TTL: never checked
    ],
  })));
  await page.goto('/#dns');
  await expect(headline(page, /^Zones 3$/)).toBeVisible();
  await expect(headline(page, /^Zones with issues \(of 2 checked\) 1$/)).toBeVisible();
});

test('DNS: a refresh that fails after a good read turns the zone counts to dashes', async ({ page }) => {
  await page.clock.install();
  let fail = false;
  await page.route('**/api/data*', (route) => (fail ? dead(route) : fulfillJson(route, dataPayload({
    zones: [{ id: 'z1', fqdn: 'a.example.', issues: ['High Neg-TTL'] }],
  }))));
  await page.goto('/#dns');
  await expect(headline(page, /^Zones 1$/)).toBeVisible();

  fail = true;
  await page.clock.runFor(31_000); // past the 30s poll
  await expect(headline(page, /^Zones [—0-9]/)).toContainText('—');
  await expect(headline(page, /^Zones with issues/)).toContainText('—');
});
