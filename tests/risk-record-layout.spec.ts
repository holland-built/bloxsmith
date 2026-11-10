import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Risk tabs are where the operator acts (ack, block, filter, load older),
// so each one leads with its working table ("C · Record-first", picked over a
// headline strip and a section rail). Incidents keeps its category chips
// directly above Triage because they filter it. The lead table sits on the page
// under one rule, and the tabs run square and dense. Incidents now puts its
// severity tiles first (owner, 2026-11-10): the counts used to sit under the
// whole Triage table, so the page's answer was the last thing on it. Triage is
// still the lead table, with the chips that filter it directly above it.
//
// Changes left the record layout on 2026-11-10 for the dashboard look the
// owner picked (soft round cards, as on Overview). It still keeps "Worth a
// look" first, because that panel carries the 500-row cap note, which must sit
// above the list it qualifies.

const CASES = [
  { tab: 'security', first: ['security-triage-inbox'], lead: 'security-triage-inbox' },
  { tab: 'incidents', first: ['incidents-severity', 'incidents-categories', 'incidents-triage'], lead: 'incidents-triage' },
  { tab: 'audit', first: ['audit-log'], lead: 'audit-log' },
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

test('#changes keeps the cap note above its list, in round cards', async ({ page }) => {
  await page.goto('/#changes');
  await expect(page.locator('[data-panel-id="changes-changed-objects"]')).toBeVisible();
  const order = await page.$$eval('[data-card-grid] [data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));
  expect(order.slice(0, 2)).toEqual(['changes-notability', 'changes-changed-objects']);
  for (const id of order.slice(0, 2)) {
    const radius = await page.locator(`[data-panel-id="${id}"]`).evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(radius).toBe('16px');
  }
});

test('the record layout stays on the Risk tabs: Estate panels keep their boxes', async ({ page }) => {
  await page.goto('/#network');
  const panel = page.locator('[data-panel-id]').first();
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe('0px');
});
