import { test, expect } from './fixtures';

// Backend contract (live-verified): every exposure feed returns an explicit
// `availability` of "ok" | "error" | "metadata-degraded", all as HTTP 200
// — so ui/src/lib/api.js's `.error` (set only on !res.ok) is ALWAYS null here.
// These specs mock the payload directly to prove Security.jsx branches on
// `availability`, not on the always-null `.error`. See ExposedSurfacePanel and
// ExposuresPanel in ui/src/tabs/Security.jsx.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const HOSTNAMES_OK = {
  availability: 'ok',
  status: 'ok',
  data: { rows: [{ hostname: 'evil.example.com' }, { hostname: 'bad.example.net' }], count: 2, total_available: 41214 },
};
const HOSTNAMES_DEAD = {
  availability: 'error',
  status: 'error',
  reason: 'upstream response too large',
  data: {},
};
const IPS_OK = {
  availability: 'ok',
  status: 'ok',
  data: { rows: [{ ip: '203.0.113.5' }, { ip: '203.0.113.6' }], count: 2, total_available: 46963 },
};
const IPS_DEGRADED = {
  availability: 'metadata-degraded',
  status: 'ok',
  // csp.go's exposureFeedResp always sets count: len(rows) — the server can
  // never emit a count that outruns the rows array. The real degraded signal
  // is the ABSENCE of a total_available key, not an inflated count.
  data: { rows: [{ ip: '198.51.100.1' }], count: 1 },
};
const IPS_DEAD = {
  availability: 'error',
  status: 'error',
  reason: 'upstream timed out',
  data: {},
};

async function mockSurface(page, hostnamesBody: unknown, ipsBody: unknown) {
  await page.route('**/api/csp/exposed-hostnames*', (route) => fulfillJson(route, hostnamesBody));
  await page.route('**/api/csp/exposed-ips*', (route) => fulfillJson(route, ipsBody));
}

test.describe('Exposed Surface panel — availability branching', () => {
  test('both feeds healthy renders both tables, no unavailable wording', async ({ page }) => {
    await mockSurface(page, HOSTNAMES_OK, IPS_OK);
    await page.goto('/#security');
    const card = page.locator('text=Exposed Surface').locator('..').locator('..');
    await expect(card.getByText('evil.example.com')).toBeVisible();
    await expect(card.getByText('203.0.113.5')).toBeVisible();
    await expect(card.getByText(/unavailable/i)).toHaveCount(0);
  });

  test('dead hostnames feed shows unavailable wording, not "no data"/zero, and IPs still render', async ({ page }) => {
    await mockSurface(page, HOSTNAMES_DEAD, IPS_OK);
    await page.goto('/#security');
    const card = page.locator('text=Exposed Surface').locator('..').locator('..');
    await expect(card.getByText(/hostname feed unavailable/i)).toBeVisible();
    await expect(card.getByText('upstream response too large')).toBeVisible();
    await expect(card.getByText('203.0.113.5')).toBeVisible(); // healthy neighbour unaffected
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
    await expect(card.getByText(/^0$/)).toHaveCount(0);
  });

  test('dead IPs feed still renders hostnames', async ({ page }) => {
    await mockSurface(page, HOSTNAMES_OK, IPS_DEAD);
    await page.goto('/#security');
    const card = page.locator('text=Exposed Surface').locator('..').locator('..');
    await expect(card.getByText(/ip feed unavailable/i)).toBeVisible();
    await expect(card.getByText('upstream timed out')).toBeVisible();
    await expect(card.getByText('evil.example.com')).toBeVisible(); // healthy neighbour unaffected
  });

  test('both feeds dead shows one whole-panel degraded state', async ({ page }) => {
    await mockSurface(page, HOSTNAMES_DEAD, IPS_DEAD);
    await page.goto('/#security');
    const card = page.locator('text=Exposed Surface').locator('..').locator('..');
    await expect(card.getByText(/exposed surface feeds unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('metadata-degraded IPs feed is labeled as loaded rows, never a total', async ({ page }) => {
    await mockSurface(page, HOSTNAMES_OK, IPS_DEGRADED);
    await page.goto('/#security');
    const card = page.locator('text=Exposed Surface').locator('..').locator('..');
    // Pin the exact rendered string (not a loose /rows loaded/i, which would
    // match any number) — with 1 row and no total_available, countLabel must
    // render "1 rows loaded", never "46,963" or any other total-shaped value.
    await expect(card.getByText('Showing 1 of 1 rows loaded')).toBeVisible();
    await expect(card.getByText('1 rows loaded IPs')).toBeVisible();
  });
});

test.describe('Exposures panel — total vs sample caption', () => {
  test('ok feed shows the real total and an upstream-order, non-ranked caption', async ({ page }) => {
    await page.route('**/api/csp/exposures*', (route) =>
      fulfillJson(route, {
        availability: 'ok',
        status: 'ok',
        data: {
          rows: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, title: `Exposure ${i}`, status: 'open' })),
          count: 5,
          total_available: 121957,
        },
      }),
    );
    await page.goto('/#security');
    const card = page.locator('text=Exposures').first().locator('..').locator('..');
    await expect(card.getByText('121,957 total')).toBeVisible();
    await expect(card.getByText(/of 121,957, upstream order/i)).toBeVisible();
    // caption must say NOT ranked by severity, never imply these rows are the worst
    await expect(card.getByText(/not ranked by severity/i)).toBeVisible();
    await expect(card.getByText(/worst/i)).toHaveCount(0);
  });
});
