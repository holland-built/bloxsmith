import { test, expect } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// The owner's pick 4 (2026-11-24): every row of headline numbers is one card
// split by thin lines, Security's design, with the number itself in red or
// amber when something is wrong. Until then Infrastructure and Assets drew
// separate boxed tiles, each with its own border and a tinted fill.
for (const tab of ['infra', 'assets']) {
  test(`#${tab}: the headline numbers are one card split by thin lines`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto(`/#${tab}`);
    const strip = page.getByRole('list', { name: 'Headline numbers' });
    await expect(strip).toBeVisible({ timeout: 20_000 });
    const look = await strip.evaluate((ul) => {
      const cs = getComputedStyle(ul);
      const tiles = Array.from(ul.querySelectorAll(':scope > li > :is(a, button)'));
      return {
        cardBorder: cs.borderTopWidth,
        gap: cs.columnGap,
        tileBorders: tiles.map((t) => getComputedStyle(t).borderTopWidth),
      };
    });
    expect(look.cardBorder).toBe('1px');
    expect(look.gap).toBe('1px');
    expect(look.tileBorders.length).toBeGreaterThan(0);
    for (const b of look.tileBorders) expect(b).toBe('0px');
  });
}

test('#infra: a tile that reports a problem shows its number in the state colour', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#infra');
  const strip = page.getByRole('list', { name: 'Headline numbers' });
  await expect(strip).toBeVisible({ timeout: 20_000 });
  const toned = strip.locator(':scope > li > [data-tone="crit"], :scope > li > [data-tone="warn"]');
  await expect(toned.first()).toBeVisible();
  const ok = await toned.evaluateAll((els) => els.map((el) => {
    const tone = el.getAttribute('data-tone');
    const want = getComputedStyle(document.documentElement).getPropertyValue(`--color-${tone}`).trim();
    const probe = document.createElement('span');
    probe.style.color = want;
    document.body.append(probe);
    const wantRgb = getComputedStyle(probe).color;
    probe.remove();
    const num = el.querySelector('.kpi-num');
    return { tone, got: num ? getComputedStyle(num).color : 'no .kpi-num', want: wantRgb };
  }));
  for (const t of ok) expect(t.got, `${t.tone} tile`).toBe(t.want);
});
