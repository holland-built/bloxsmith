import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Page } from '@playwright/test';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// A chart is a recharts surface with role="application". Until this file each
// one had no name and no description, so a screen reader said "application"
// and nothing about what was drawn: ten charts on six pages.
//
// Each chart now carries a name, its panel's title, and a description built
// from the points it draws (ui/src/lib/chartSummary.js). The checks below ask
// the BROWSER what it computed, not only the page what it wrote: an attribute
// can be present and still not reach the accessibility tree.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const CHART = 'svg.recharts-surface[role="application"]';

// What the page wrote on each chart.
async function chartsOnPage(page: Page) {
  return page.locator(CHART).evaluateAll((els) =>
    els.map((el) => ({
      label: el.getAttribute('aria-label') || '',
      desc: el.querySelector(':scope > desc')?.textContent || '',
      // An SVG <title> pops up as a browser tooltip over the whole chart.
      title: el.querySelector(':scope > title')?.textContent || '',
    })),
  );
}

// What Chrome exposes to assistive technology for each chart.
async function chartsInAccessibilityTree(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  await cdp.detach();
  return nodes
    .filter((n) => !n.ignored && n.role?.value === 'application')
    .map((n) => ({ name: String(n.name?.value ?? ''), description: String(n.description?.value ?? '') }));
}

// The charts the fixture world draws, page by page, by name.
const PAGES: [string, string[]][] = [
  ['overview', ['DNS Query Rate — 24h chart', 'Top Consumers chart', 'Host Status chart']],
  ['dns', ['DNS Query Rate — 24h chart', 'Query Volume — 7d chart']],
  ['network', ['Utilization Distribution chart']],
  ['security', ['Threat Events — by Severity chart', 'Threat Feed Activity chart']],
  ['infra', ['Host Status chart']],
  ['incidents', ['Action Volume chart']],
];

for (const [tab, names] of PAGES) {
  test(`every chart on "${tab}" has a name and says what it shows`, async ({ page }) => {
    await page.goto(`/#${tab}`);
    await expect(page.locator(CHART)).toHaveCount(names.length, { timeout: 20_000 });

    const written = await chartsOnPage(page);
    expect(written.map((c) => c.label).sort()).toEqual([...names].sort());
    for (const c of written) {
      expect(c.desc, `${tab}: "${c.label}" has no description`).not.toBe('');
      expect(c.desc, `${tab}: "${c.label}" describes a chart that has data as empty`).not.toBe('No data.');
      expect(c.title, `${tab}: "${c.label}" carries an SVG title, which shows as a second tooltip`).toBe('');
    }

    const exposed = await chartsInAccessibilityTree(page);
    for (const c of written) {
      const node = exposed.find((n) => n.name === c.label);
      expect(node, `${tab}: the browser exposes no application named "${c.label}"`).toBeTruthy();
      expect(node!.description, `${tab}: the browser does not expose the description of "${c.label}"`).toBe(c.desc);
    }
  });
}

// The sentences below are worked out from tests/page-fixtures.ts, not copied
// from the page: three subnets using 25, 215 and 249 addresses; three hosts,
// one "ok", one degraded, one offline; seven days of 1000 + 250 per day.
const descriptionOf = async (page: Page, name: string) =>
  (await chartsOnPage(page)).find((c) => c.label === name)?.desc;

test('a few points are read out one by one: the subnets that use the most addresses', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator(CHART)).toHaveCount(3, { timeout: 20_000 });
  expect(await descriptionOf(page, 'Top Consumers chart')).toBe(
    'Addresses used: 10.30.0.0 249, 10.20.0.0 215, 10.10.0.0 25.',
  );
});

test('a donut says each slice: the hosts by state', async ({ page }) => {
  // "ok" is not one of the states Infra names, so that host is drawn as Other.
  await page.goto('/#infra');
  await expect(page.locator(CHART)).toHaveCount(1, { timeout: 20_000 });
  expect(await descriptionOf(page, 'Host Status chart')).toBe('Hosts: Degraded 1, Offline 1, Other 1.');
});

test('a long run gives its ends, its lowest and its highest: a week of queries', async ({ page }) => {
  await page.goto('/#dns');
  await expect(page.locator(CHART)).toHaveCount(2, { timeout: 20_000 });
  expect(await descriptionOf(page, 'Query Volume — 7d chart')).toBe(
    'Queries: 7 values, Dec 26 to Jan 1. Lowest 1,000 at Dec 26, highest 2,500 at Jan 1.',
  );
});
