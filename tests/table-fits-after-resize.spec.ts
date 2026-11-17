import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import { gotoTab, tableOverflow } from './layout-helpers';

// A table must fit its panel on the first frame after the panel narrows, not
// one frame later. DataTable used to re-measure on the frame AFTER its box
// shrank, so for one painted frame the DHCP Leases table kept its old 1638px
// width inside an 802px panel: a visible flash of sideways scroll, and the
// reason layout-drag.spec.ts failed on slower CI runners.
test('a table fits its panel on the first frame after the panel narrows', async ({ page }) => {
  await installBaselineWorld(page);
  await gotoTab(page, 'network', 5);
  expect(await tableOverflow(page)).toEqual([]);
  const over = await page.evaluate(async () => {
    const panel = document.querySelector('[data-panel-id="network-dhcp-leases"]') as HTMLElement;
    let item = panel;
    while (item.parentElement && getComputedStyle(item.parentElement).display !== 'grid') item = item.parentElement;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const wrap = panel.querySelector('table')!.parentElement as HTMLElement;
    item.style.gridColumn = 'span 3 / span 3';
    void wrap.clientWidth; // lay the narrower panel out now
    await frame(); // the next frame, as it starts
    return { panelWidth: wrap.clientWidth, tableWidth: wrap.scrollWidth };
  });
  expect(over.tableWidth).toBeLessThanOrEqual(over.panelWidth);
});
