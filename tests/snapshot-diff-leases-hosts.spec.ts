import { test, expect } from '@playwright/test';

// Extends F7 Compare-to-snapshot (see snapshot-diff.spec.ts, Subnets-only) to the
// DHCP Leases and Hosts tables. Same store (bx.snap / useSnapshots / SnapshotWriter),
// same diffRows() helper, same dt-diff gutter/glyph rendering — no parallel diff
// mechanism. HARD GATE: signal is a glyph (+/-/~) + aria/text label per row, never
// a color-only cue.

const PREV_SNAP_DAY = {
  date: '2020-01-01', // always < "today" — deterministic "prev" pick
  ts: 0,
  subnets: { n: 0, gt85: 0, b7085: 0, top: [] },
  leases: {
    n: 3, active: 2,
    top: [
      { a: '10.0.1.1', s: 'active', h: 'host-a' },  // unchanged below
      { a: '10.0.1.2', s: 'active', h: 'host-b' },  // state changes to expired below
      { a: '10.0.1.9', s: 'active', h: 'host-c' },  // absent below -> removed/ghost
    ],
  },
  zones: { n: 0, issues: 0 },
  hosts: {
    n: 3, online: 2, offline: 1,
    top: [
      { n: 'host-alpha', s: 'online' },  // unchanged below
      { n: 'host-beta', s: 'online' },   // status changes to offline below
      { n: 'host-gamma', s: 'online' },  // absent below -> removed/ghost
    ],
  },
  sec: { crit: 0, high: 0, med: 0, low: 0, blocked: 0, logged: 0, total: 0 },
  dns7d: null,
};

const LEASES = [
  { addr: '10.0.1.1', mac: 'AA:AA:AA:AA:AA:01', state: 'active', host: 'host-a' },  // unchanged
  { addr: '10.0.1.2', mac: 'AA:AA:AA:AA:AA:02', state: 'expired', host: 'host-b' }, // changed
  { addr: '10.0.1.5', mac: 'AA:AA:AA:AA:AA:05', state: 'active', host: 'host-d' },  // added
];

const HOSTS = [
  { id: 'ha', name: 'host-alpha', ip: '10.0.2.1', type: 'Grid Member', status: 'online' },  // unchanged
  { id: 'hb', name: 'host-beta', ip: '10.0.2.2', type: 'Grid Member', status: 'offline' },  // changed
  { id: 'hd', name: 'host-delta', ip: '10.0.2.9', type: 'Grid Member', status: 'online' },  // added
];

const DATA = { subnets: [], leases: LEASES, zones: [], hosts: HOSTS, auditLogs: [], events: [] };

test('Compare to snapshot marks +/~/- on the Leases table (Network tab)', async ({ page }) => {
  await page.addInitScript((snap) => {
    localStorage.setItem('bx.snap', JSON.stringify({ v: 1, days: [snap] }));
  }, PREV_SNAP_DAY);

  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto((process.env.SPEC_BASE_URL || '') + '/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const compareBtn = page.getByRole('button', { name: 'Compare leases to snapshot' });
  await expect(compareBtn).toBeEnabled();
  await compareBtn.click();
  await expect(page.getByRole('button', { name: 'Comparing leases' })).toBeVisible();

  const leasesPanel = page.locator('.pcard', { hasText: 'All leases' });
  const table = leasesPanel.locator('table.dt');

  // Added row (new addr 10.0.1.5): '+' glyph, aria-label "added".
  const addedGlyph = table.locator('tr', { hasText: '10.0.1.5' }).locator('.dt-diff span');
  await expect(addedGlyph).toHaveText('+');
  await expect(addedGlyph).toHaveAttribute('aria-label', 'added');

  // Changed row (10.0.1.2 active->expired): '~' glyph, aria-label "changed".
  const changedGlyph = table.locator('tr', { hasText: '10.0.1.2' }).locator('.dt-diff span');
  await expect(changedGlyph).toHaveText('~');
  await expect(changedGlyph).toHaveAttribute('aria-label', 'changed');

  // Unchanged row (10.0.1.1): gutter renders, no glyph/label.
  const unchangedGlyph = table.locator('tr', { hasText: '10.0.1.1' }).locator('.dt-diff span');
  await expect(unchangedGlyph).toHaveCount(0);

  // Removed row (10.0.1.9, absent from current leases): struck-through ghost row.
  const ghostRow = table.locator('tr.dt-ghost');
  await expect(ghostRow).toHaveCount(1);
  const ghostGlyph = ghostRow.locator('.dt-diff span');
  await expect(ghostGlyph).toHaveText('−');
  await expect(ghostGlyph).toHaveAttribute('aria-label', 'removed');

  // HARD GATE — glyph color must equal ordinary body text, never --crit/--ok.
  const [glyphColor, textColor, critColor, okColor] = await Promise.all([
    addedGlyph.evaluate(el => getComputedStyle(el).color),
    page.evaluate(() => getComputedStyle(document.body).color),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--crit').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()),
  ]);
  expect(glyphColor).toBe(textColor);
  expect(glyphColor.toLowerCase()).not.toContain(critColor.toLowerCase());
  expect(glyphColor.toLowerCase()).not.toContain(okColor.toLowerCase());
});

test('Compare to snapshot marks +/~/- on the Hosts table (Infra tab)', async ({ page }) => {
  await page.addInitScript((snap) => {
    localStorage.setItem('bx.snap', JSON.stringify({ v: 1, days: [snap] }));
  }, PREV_SNAP_DAY);

  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );
  await page.route('**/api/host-metrics', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics: [] }) })
  );

  await page.goto((process.env.SPEC_BASE_URL || '') + '/#infra', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();

  const compareBtn = page.getByRole('button', { name: 'Compare hosts to snapshot' });
  await expect(compareBtn).toBeEnabled();
  await compareBtn.click();
  await expect(page.getByRole('button', { name: 'Comparing hosts' })).toBeVisible();

  // Exact-title match — several other Infra panels ("Needs attention", "Status",
  // "Hottest host") also contain the substring "host(s)" in their body text.
  const hostsPanel = page.locator('.pcard').filter({ has: page.locator('h3 > span', { hasText: /^Hosts$/ }) });
  const table = hostsPanel.locator('table.dt');

  // Added row (host-delta): '+' glyph, aria-label "added".
  const addedGlyph = table.locator('tr', { hasText: 'host-delta' }).locator('.dt-diff span');
  await expect(addedGlyph).toHaveText('+');
  await expect(addedGlyph).toHaveAttribute('aria-label', 'added');

  // Changed row (host-beta online->offline): '~' glyph, aria-label "changed".
  const changedGlyph = table.locator('tr', { hasText: 'host-beta' }).locator('.dt-diff span');
  await expect(changedGlyph).toHaveText('~');
  await expect(changedGlyph).toHaveAttribute('aria-label', 'changed');

  // Unchanged row (host-alpha): gutter renders, no glyph/label.
  const unchangedGlyph = table.locator('tr', { hasText: 'host-alpha' }).locator('.dt-diff span');
  await expect(unchangedGlyph).toHaveCount(0);

  // Removed row (host-gamma, absent from current hosts): struck-through ghost row.
  const ghostRow = table.locator('tr.dt-ghost');
  await expect(ghostRow).toHaveCount(1);
  const ghostGlyph = ghostRow.locator('.dt-diff span');
  await expect(ghostGlyph).toHaveText('−');
  await expect(ghostGlyph).toHaveAttribute('aria-label', 'removed');

  // HARD GATE — glyph color must equal ordinary body text, never --crit/--ok.
  const [glyphColor, textColor, critColor, okColor] = await Promise.all([
    addedGlyph.evaluate(el => getComputedStyle(el).color),
    page.evaluate(() => getComputedStyle(document.body).color),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--crit').trim()),
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ok').trim()),
  ]);
  expect(glyphColor).toBe(textColor);
  expect(glyphColor.toLowerCase()).not.toContain(critColor.toLowerCase());
  expect(glyphColor.toLowerCase()).not.toContain(okColor.toLowerCase());
});
