import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Risk tabs are where the operator acts (ack, block, filter, load older),
// so each one leads with its working table ("C · Record-first", picked over a
// headline strip and a section rail). Incidents keeps its category chips
// directly above Triage because they filter it, and Changes keeps Notability
// first because it carries the 500-row cap warning, which must sit above the
// list it qualifies. The lead table sits on the page under one rule, and the
// tabs run square and dense.

const CASES = [
  { tab: 'security', first: ['security-triage-inbox'], lead: 'security-triage-inbox' },
  { tab: 'incidents', first: ['incidents-categories', 'incidents-triage'], lead: 'incidents-triage' },
  { tab: 'audit', first: ['audit-log'], lead: 'audit-log' },
  { tab: 'changes', first: ['changes-notability', 'changes-changed-objects'], lead: 'changes-changed-objects' },
];

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

for (const c of CASES) {
  test(`#${c.tab} leads with its working table, on the page and square`, async ({ page }) => {
    await page.goto(`/#${c.tab}`);
    const lead = page.locator(`[data-panel-id="${c.lead}"]`);
    await expect(lead).toBeVisible();

    const order = await page.$$eval('[data-card-grid] [data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));
    expect(order.slice(0, c.first.length)).toEqual(c.first);

    const style = await lead.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, side: s.borderLeftColor };
    });
    expect(style.bg).toBe('rgba(0, 0, 0, 0)');
    expect(style.radius).toBe('0px');
    expect(style.side).toBe('rgba(0, 0, 0, 0)');
  });
}

test('the record layout stays on the Risk tabs: Estate panels keep their boxes', async ({ page }) => {
  await page.goto('/#network');
  const panel = page.locator('[data-panel-id]').first();
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe('0px');
});
