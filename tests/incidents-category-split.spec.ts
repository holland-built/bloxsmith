import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A category chip used to show its total beside one letter for its WORST
// severity, so "C 1,745 subnet-utilization" read as 1,745 critical incidents
// while the Severity panel said 953. The chip now shows how its total splits
// by severity, counted from the same rows the Severity panel counts. When
// those rows are only part of the list (the server capped it), the split
// would not add up to the total, so the chip names the worst severity instead.

const sig = (category: string, severity: string, i: number) => ({
  category, severity, entity_id: `ipam/subnet/${category}-${i}`, entity_type: 'subnet',
  message: `row ${i}`, detected_at: 1789908095, source: 'network',
});

function incidents(opts: { count: number; signals: object[]; truncated: boolean }) {
  return {
    _meta: { leases: 'ok', subnets: 'ok', zones: 'ok' },
    incidents: [{ category: 'subnet-utilization', key: 'subnet-utilization', count: opts.count, severity: 'crit', entity_type: 'subnet', message: `${opts.count} subnet utilization`, sample_entities: [], first_detected_at: 1789908095 }],
    signals: opts.signals,
    signals_total: opts.count,
    signals_truncated: opts.truncated,
    signals_degraded: false,
    snoozes: {},
  };
}

const chip = (page: import('@playwright/test').Page) =>
  page.locator('[data-panel-id="incidents-categories"]').getByRole('button', { name: /subnet-utilization/ });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('a chip shows how its total splits by severity, matching the Severity panel', async ({ page }) => {
  const rows = [sig('subnet-utilization', 'crit', 1), sig('subnet-utilization', 'crit', 2), sig('subnet-utilization', 'warn', 3)];
  await page.route('**/api/incidents', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(incidents({ count: 3, signals: rows, truncated: false })) }));
  await page.goto('/#incidents');
  await expect(chip(page)).toContainText('3');
  await expect(chip(page)).toContainText('2 critical, 1 medium');
  // The Severity panel counts the same rows.
  await expect(page.locator('[data-panel-id="incidents-severity"]')).toContainText(/Critical\s*2/);
});

test('when the list is capped, the chip names the worst severity instead of a split that cannot add up', async ({ page }) => {
  const rows = [sig('subnet-utilization', 'crit', 1), sig('subnet-utilization', 'warn', 2)];
  await page.route('**/api/incidents', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(incidents({ count: 40, signals: rows, truncated: true })) }));
  await page.goto('/#incidents');
  await expect(chip(page)).toContainText('40');
  await expect(chip(page)).toContainText('worst: critical');
  await expect(chip(page)).not.toContainText('1 critical');
});
