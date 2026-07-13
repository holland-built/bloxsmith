import { test, expect } from '@playwright/test';

// P1 slice 4 — app-wide cross-filter from stat tiles + a service health strip.
// Two mechanisms, ONE FilterCtx:
//   1. The Overview "Hosts" stat card's online/degraded/offline numbers become real
//      buttons. Clicking one writes an app-wide FilterCtx scope (status:<value>) that
//      is mirrored to the shareable `f=` view-state hash, renders the existing
//      removable FilterBar chip, and filters any table that has a `status` column
//      (e.g. the Infra hosts inventory) — no mystery filters: always visible + clearable.
//   2. A slim always-visible HealthStrip in the shell shows a per-service dot
//      (semantic color) + TEXT status label + tiny sparkline for DNS/DHCP/IPAM/Security.
//      Each segment is a real button that navigates to that service's tab.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const HOSTS = [
  { id: 'h1', name: 'ns-01',   ip: '10.0.0.1', type: 'server', status: 'online'   },
  { id: 'h2', name: 'ns-02',   ip: '10.0.0.2', type: 'server', status: 'online'   },
  { id: 'h3', name: 'dhcp-01', ip: '10.0.0.3', type: 'server', status: 'degraded' },
  { id: 'h4', name: 'edge-01', ip: '10.0.0.4', type: 'router', status: 'offline'  },
];
const SUBNETS = [
  { id: 's1', name: 'A', addr: '10.1.0.0', cidr: 24, util: 95, site: 'HQ' },
  { id: 's2', name: 'B', addr: '10.2.0.0', cidr: 24, util: 40, site: 'DR' },
];
const ZONES = [
  { id: 'z1', fqdn: 'example.com', status: 'ok', records: 10 },
  { id: 'z2', fqdn: 'corp.net',    status: 'ok', records: 5 },
];
const DATA = { subnets: SUBNETS, leases: [], zones: ZONES, hosts: HOSTS, auditLogs: [], events: [] };
const SECURITY = {
  counts: { critical: 2, high: 1, medium: 3 }, blocked: 1, logged: 2, total: 6,
  events: [{ severity: 'critical', qname: 'bad.example', policy_action: 'block', feed_name: 'f', device: 'd', event_time: '2026-07-09T10:00:00Z' }],
};

async function mock(page: any) {
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SECURITY) }));
}

test('clicking the OFFLINE host-status tile sets an app scope chip, encodes it in the URL, and toggles off', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview');

  const offBtn = page.locator('.stat-crossfilter[data-scope="status:offline"]');
  await expect(offBtn).toBeVisible();
  await expect(offBtn).toContainText('1');              // the single offline host
  await expect(offBtn).toContainText('down');           // visible text cue, not color-only (H1 audit fix)
  await expect(offBtn).toHaveAttribute('aria-pressed', 'false');

  await offBtn.click();
  await expect(offBtn).toHaveAttribute('aria-pressed', 'true');

  // Visible, labeled, removable scope chip in the existing FilterBar.
  const chip = page.locator('.filter-bar .chip', { hasText: 'Status: offline' });
  await expect(chip).toBeVisible();
  // Encoded in the shareable view-state hash.
  await expect(page).toHaveURL(/f=status%3Aoffline/);

  // Toggling the same tile clears the scope (fx.toggle is symmetric).
  await offBtn.click();
  await expect(page.locator('.filter-bar')).toHaveCount(0);
  await expect(page).not.toHaveURL(/f=status/);
});

test('the app scope filters the Infra hosts table and the chip clears it (deep-link restores)', async ({ page }) => {
  await mock(page);
  // Deep-link straight to the encoded scope — proves it is URL-driven + restorable.
  await page.goto('/#infra?f=status%3Aoffline');

  const rows = page.locator('table.dt tbody tr.clickable');
  await expect(rows.filter({ hasText: 'edge-01' })).toBeVisible(); // offline host kept
  await expect(rows.filter({ hasText: 'ns-01' })).toHaveCount(0);  // online host filtered out

  const chip = page.locator('.filter-bar .chip', { hasText: 'Status: offline' });
  await expect(chip).toBeVisible();
  await chip.click();                                              // one-click clear
  await expect(rows.filter({ hasText: 'ns-01' })).toBeVisible();   // rows restored
});

test('the health strip renders per-service dots + TEXT labels + a sparkline, and a segment navigates', async ({ page }) => {
  await mock(page);
  await page.goto('/#overview');

  const strip = page.locator('.health-strip');
  await expect(strip).toBeVisible();

  for (const svc of ['DNS', 'DHCP', 'IPAM', 'Security']) {
    const seg = strip.locator('.health-seg', { hasText: svc });
    await expect(seg).toBeVisible();
    await expect(seg.locator('.health-status')).not.toHaveText(''); // status is TEXT, not color-only
    await expect(seg.locator('svg.spark')).toBeVisible();           // tiny sparkline
  }

  // Security has 2 critical threats → semantic TEXT status.
  const secSeg = strip.locator('.health-seg', { hasText: 'Security' });
  await expect(secSeg.locator('.health-status')).toHaveText(/Critical/i);

  // Clicking a segment navigates to that service's tab.
  await secSeg.click();
  await expect(page).toHaveURL(/#security/);
});
