import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Security counts cover the whole hour (2026-11-21). The list stays short, so
// each page must say what the numbers cover and what the list shows.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const events = Array.from({ length: 50 }, (_, i) => ({
  event_time: new Date(Date.now() - i * 1000).toISOString(),
  qname: `host${i}.example`,
  severity: i === 0 ? 'critical' : 'low',
  policy_action: 'block',
}));
const base = { availability: 'ok', events, returned: 50, blocked: 300, logged: 54, counts: { critical: 4, high: 17, medium: 30, low: 303 } };
const WHOLE_HOUR = { ...base, counted: 354, complete: true, truncated: false, total: 354 };
const CAPPED = { ...base, counted: 5000, complete: false, truncated: true };
const useHub = (page: Page, body: unknown) => page.route('**/api/hub/security*', (route) => json(route, body));
const row = (page: Page) => page.locator('[data-board] [data-board-row="Security"]');
const tile = (page: Page) => page.getByRole('region', { name: 'Services at a glance' }).getByRole('button', { name: /^Security / });
const card = (page: Page, title: string) => page.locator('[data-panel-id], section, article').filter({ has: page.getByText(title, { exact: true }) }).last();

test('Overview: a complete hour reads as the last hour', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, WHOLE_HOUR);
  await page.goto('/#overview');
  await expect(tile(page)).toContainText('21 critical or high events', { timeout: 20_000 });
  await expect(tile(page)).toContainText('last hour');
  await expect(tile(page)).not.toContainText('latest');
});

test('Overview: a capped read names the number counted', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, { ...CAPPED, counts: { critical: 0, high: 0, medium: 0, low: 5000 } });
  await page.goto('/#overview');
  await expect(row(page)).toContainText('none in the latest 5,000 events', { timeout: 20_000 });
});

test('Daily: a complete hour shows its true count', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, WHOLE_HOUR);
  await page.goto('/#daily');
  await expect(card(page, 'Security today')).toContainText('354 events', { timeout: 20_000 });
  await expect(card(page, 'Security today')).not.toContainText('total unknown');
});

test('Daily: a capped read says it covers only the newest events', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, CAPPED);
  await page.goto('/#daily');
  await expect(card(page, 'Security today')).toContainText('newest 5,000 events', { timeout: 20_000 });
});

test('Security: a complete hour counts the hour and says what the list shows', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, WHOLE_HOUR);
  await page.goto('/#security');
  const summary = card(page, 'Response summary');
  await expect(summary).toContainText('Total Events', { timeout: 20_000 });
  await expect(summary).toContainText('354');
  // Acknowledgements are per listed row, so this figure names its scope.
  await expect(summary).toContainText('newest 50');
  await expect(card(page, 'Triage inbox')).toContainText('Showing the newest 50 of 354 events.');
  await expect(card(page, 'Threat events by hour')).toContainText('354 events');
  await expect(card(page, 'Threat events by hour')).toContainText('Showing the newest 50 of 354 events.');
});

test('Security: a capped read keeps its caveat with the real number', async ({ page }) => {
  await installBaselineWorld(page);
  await useHub(page, CAPPED);
  await page.goto('/#security');
  const summary = card(page, 'Response summary');
  await expect(summary).toContainText('Events Counted', { timeout: 20_000 });
  await expect(summary).toContainText('Covers only the newest 5,000 events in this window.');
  await expect(card(page, 'Triage inbox')).toContainText('Showing the newest 50 of the 5,000 events counted.');
});
