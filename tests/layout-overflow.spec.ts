import { test, expect } from '@playwright/test';

// THE NUMERIC GATE. For each tab at each viewport: no element overflows its own
// box horizontally (excluding intentional overflow-x auto/scroll scrollers and
// their descendants), and the document itself never exceeds the viewport width.

const TABS = ['overview', 'network', 'dns', 'infra', 'security', 'audit', 'ask'];
const VIEWPORTS = [
  { w: 1400, h: 900 },
  { w: 375, h: 812 },
];

// Runs in the browser: count elements wider than their client box, skipping any
// element that is (or descends from) a scroll container with overflow-x auto/scroll.
function overflowProbe() {
  const els = Array.from(document.querySelectorAll('*')) as HTMLElement[];
  // An element whose overflow-x is anything other than 'visible' clips or scrolls
  // its own content and therefore cannot push the page wider — this covers the
  // intentional auto/scroll scrollers (.tbl-wrap, .sensor-wrap) AND ellipsis-
  // truncated cells (overflow:hidden + text-overflow:ellipsis), whose
  // scrollWidth > clientWidth is expected clipping, not real horizontal overflow.
  const isScroller = (el: Element) => getComputedStyle(el).overflowX !== 'visible';
  const inScroller = (el: Element | null) => {
    let n: Element | null = el;
    while (n) {
      if (isScroller(n)) return true;
      n = n.parentElement;
    }
    return false;
  };
  const offenders: string[] = [];
  for (const el of els) {
    if (el.scrollWidth > el.clientWidth + 1 && !inScroller(el)) {
      offenders.push(
        (el.tagName.toLowerCase()) +
          (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : '') +
          ' sw=' + el.scrollWidth + ' cw=' + el.clientWidth
      );
    }
  }
  return {
    count: offenders.length,
    offenders: offenders.slice(0, 10),
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
}

for (const vp of VIEWPORTS) {
  for (const tab of TABS) {
    test(`no horizontal overflow on #${tab} at ${vp.w}x${vp.h}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      await page.goto('/#' + tab, { waitUntil: 'networkidle' });
      await expect(page.locator('.tabbar')).toBeVisible();
      await page.waitForTimeout(1500);

      await page.screenshot({ path: `test-results/overflow-${tab}-${vp.w}.png`, fullPage: true });

      const res = await page.evaluate(overflowProbe);
      expect(res.count, `overflowing elements: ${JSON.stringify(res.offenders)}`).toBe(0);
      expect(res.docOverflow, 'document scrollWidth exceeds viewport').toBeLessThanOrEqual(1);
    });
  }
}
