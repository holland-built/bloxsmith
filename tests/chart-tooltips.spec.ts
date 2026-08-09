import { test, expect } from './fixtures';

// THE ARBITER FOR CHART HOVER COPY.
//
// Why this file exists at all. An earlier hand probe reported three charts as
// showing "NO TOOLTIP ANYWHERE"; a second, wider sweep against both :8080 and
// :8090 could not reproduce it — every one of those three rendered a tooltip on
// hover. Two probes, two answers, no way to tell which was true tomorrow. So the
// question stops being a matter of opinion here: this spec is the record, and
// whatever it says on any given day is what the charts actually do.
//
// It asserts the thing the probes disagreed about (a tooltip appears) and, more
// importantly, the thing neither of them tested — what the tooltip SAYS. The
// reader of this dashboard is a network operator, not a React developer. A
// tooltip reading `value : 346.1144444444444` leaks a `dataKey`, a float that
// nothing measured to that precision, and no unit. Three rules, deliberately
// mechanical so they cannot be argued with:
//
//   1. none of the raw recharts series tokens `value :` / `requests :` / `count :`
//   2. no number carrying two or more decimal places
//   3. no raw ISO fragment `T00:00:00`
//
// WHAT THIS SPEC CANNOT SEE, stated rather than implied. It cannot tell whether
// a plain-English label is the RIGHT label — "queries per second" on a chart of
// zones would pass every rule above. It only proves the copy is in human words
// and the numbers are ones a person would write down. Correctness of meaning
// stays a review job.
//
// A red line here is not a flake. Each failure names the panel and quotes the
// tooltip text verbatim, so the fix is always visible in the failure message.

const HOVER_SETTLE_MS = 70;
// Cold /api/data has been measured at 6.55–9.65s in this repo (see the
// derivation in tests/drilldown.spec.ts); charts render only after it resolves.
const CHART_READY_MS = 15_000;

type Chart = { tab: string; panel: string; what: string };

// All 11 recharts charts in the app, by the `panelId` their Card carries.
// Verified against the 11 `<Tooltip>` call sites: Overview.jsx:286/401/571,
// Dns.jsx:122/287, Security.jsx:129/489, Infra.jsx:190, Incidents.jsx:555,
// Audit.jsx:102, Network.jsx:148. If a 12th chart appears, it belongs here.
const CHARTS: Chart[] = [
  { tab: 'overview', panel: 'dns-hero', what: 'DNS Query Rate — 24h area' },
  { tab: 'overview', panel: 'top-consumers', what: 'Top Consumers bars' },
  { tab: 'overview', panel: 'host-status', what: 'Host Status donut' },
  { tab: 'network', panel: 'network-utilization-distribution', what: 'Utilization Distribution bars' },
  { tab: 'dns', panel: 'dns-query-rate', what: 'Query Rate area' },
  { tab: 'dns', panel: 'dns-query-volume-7d', what: 'Query Volume — 7d bars' },
  { tab: 'security', panel: 'security-threat-events', what: 'Threat Events by severity' },
  { tab: 'security', panel: 'security-threat-feed-activity', what: 'Threat Feed Activity bars' },
  { tab: 'infra', panel: 'infra-host-status', what: 'Host Status donut' },
  { tab: 'incidents', panel: 'incidents-action-volume', what: 'Action Volume bars' },
  { tab: 'audit', panel: 'audit-activity-summary', what: 'Activity Summary bars' },
];

const HEATMAP = { tab: 'overview', panel: 'subnet-heatmap' };

// A dotted quad is not a decimal. `10.11.1.0` and `10.61.30.0/24` both satisfy
// /\d+\.\d{2,}/ while containing no fractional part at all, and this dashboard
// is mostly about subnets — without this the decimal rule would condemn Top
// Consumers, whose copy ("10.11.1.0 · 204 used (80%)") is the model the rest of
// the charts are being moved TOWARDS. Masked out for the precision rule only;
// every other rule still reads the whole string.
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/g;

// The three rules, each with the plain-English complaint it stands for.
const RULES: { name: string; re: RegExp; why: string; on?: (t: string) => string }[] = [
  {
    name: 'raw series key',
    re: /\b(value|requests|count)\s*:/i,
    why: 'that is a recharts dataKey, not a word an operator uses',
  },
  {
    name: 'over-precise number',
    re: /\d+\.\d{2,}/,
    why: 'nothing on this dashboard was measured to two decimal places',
    on: (t) => t.replace(IPV4, ' '),
  },
  {
    name: 'raw ISO timestamp',
    re: /T00:00:00/,
    why: 'a date should read "Aug 1", not a machine timestamp',
  },
];

function violations(text: string): string[] {
  return RULES.filter((r) => r.re.test(r.on ? r.on(text) : text)).map((r) => `${r.name} (${r.why})`);
}

// Reads the tooltip belonging to ONE panel. Recharts keeps
// .recharts-tooltip-wrapper in the DOM permanently and hides it, so presence
// alone proves nothing — computed visibility and non-empty text both matter.
async function tooltipText(page: import('@playwright/test').Page, panel: string): Promise<string> {
  return page.evaluate((p) => {
    const card = document.querySelector(`[data-panel-id="${p}"]`);
    if (!card) return '';
    const w = card.querySelector('.recharts-tooltip-wrapper');
    if (!w) return '';
    const cs = getComputedStyle(w as Element);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return '';
    return ((w as HTMLElement).innerText || w.textContent || '').replace(/\s+/g, ' ').trim();
  }, panel);
}

async function chartBox(page: import('@playwright/test').Page, panel: string) {
  const wrapper = page.locator(`[data-panel-id="${panel}"] .recharts-wrapper`).first();
  await expect(
    wrapper,
    `panel "${panel}" never rendered a recharts surface — either the panel is hidden, ` +
      `its feed failed, or the panelId changed`,
  ).toBeVisible({ timeout: CHART_READY_MS });
  // MUST scroll first. mouse.move() and touchscreen.tap() take VIEWPORT
  // coordinates and do not auto-scroll the way locator.hover() does, while
  // boundingBox() returns the box wherever it currently sits. Without this, any
  // panel below the fold — Security's Threat Feed Activity and Incidents' Action
  // Volume, both near the bottom of long tabs — gets swept at coordinates off
  // the bottom of the window and reports "no tooltip anywhere". That is almost
  // certainly what the original hand probe measured, and repeating it here would
  // have written the same wrong answer into a permanent spec.
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  expect(box, `panel "${panel}" has a recharts surface with no box`).toBeTruthy();
  return box!;
}

// A grid sweep rather than one centre point: a donut's centre is a hole, a
// sparse bar chart is mostly empty space, and an area chart only answers near
// its own line. 33 points is enough to hit every shape in this app.
const XS = [0.08, 0.2, 0.32, 0.44, 0.5, 0.56, 0.68, 0.8, 0.92];
const YS = [0.5, 0.28, 0.72, 0.12];

async function hoverForTooltip(page: import('@playwright/test').Page, panel: string) {
  const box = await chartBox(page, panel);
  const tried: string[] = [];
  for (const fy of YS) {
    for (const fx of XS) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      await page.mouse.move(x, y);
      await page.waitForTimeout(HOVER_SETTLE_MS);
      const text = await tooltipText(page, panel);
      if (text) return { text, at: `${Math.round(fx * 100)}%,${Math.round(fy * 100)}%` };
      tried.push(`${Math.round(fx * 100)},${Math.round(fy * 100)}`);
    }
  }
  return { text: '', at: `swept ${tried.length} points and none answered` };
}

for (const c of CHARTS) {
  test(`chart "${c.panel}" (${c.what}) says something a person can read`, async ({ page }) => {
    await page.goto(`/#${c.tab}`);
    await expect(page.locator('h1').first()).toBeVisible();

    const { text, at } = await hoverForTooltip(page, c.panel);
    expect(text, `no tooltip appeared on "${c.panel}": ${at}`).not.toBe('');

    const bad = violations(text);
    expect(
      bad,
      `tooltip on "${c.panel}" (hovered at ${at}) reads:\n    ${text}\n  which breaks: ${bad.join('; ')}`,
    ).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// The heatmap. Not a recharts chart — hand-rolled <rect>s whose only readout is
// a native <title>, which costs about a second of hover before the OS draws it,
// cannot be styled to match anything else on the page, and does not exist at all
// on a touchscreen. The replacement is an in-app readout carrying
// [data-heatmap-readout], plus an aria-label per rect so a screen reader keeps
// what <title> was genuinely good at.
// ---------------------------------------------------------------------------

test('heatmap: pointing at a square shows an in-app readout naming the subnet and its %', async ({ page }) => {
  await page.goto(`/#${HEATMAP.tab}`);
  await expect(page.locator('h1').first()).toBeVisible();

  const rect = page.locator(`[data-panel-id="${HEATMAP.panel}"] svg rect`).first();
  await expect(rect, 'the heatmap never drew a square').toBeVisible({ timeout: CHART_READY_MS });

  // MUST scroll first, for the reason already written out at chartBox() above:
  // mouse.move() takes VIEWPORT coordinates and does not auto-scroll, while
  // boundingBox() reports the box wherever it currently sits. Measured on
  // 2026-08-09 at the default 1280x720: this square sat at y=696 and passed by
  // 24px, and adding one 22px row of chrome above the grid (the Arrange panels
  // strip) put it at y=731 — off the bottom of the window, where the sweep
  // reported "no readout" for a panel that was working perfectly. The margin
  // was luck, not a guarantee, so it is removed rather than restored.
  await rect.scrollIntoViewIfNeeded();
  const box = (await rect.boundingBox())!;
  expect(box.y + box.height, 'the heatmap square is still below the fold after scrolling')
    .toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const readout = page.locator(`[data-panel-id="${HEATMAP.panel}"] [data-heatmap-readout]`);
  await expect(
    readout,
    'pointing at a heatmap square must show an in-app readout, not a native <title> ' +
      '(~1s OS delay, unstyleable, absent on touch)',
  ).toBeVisible({ timeout: 2000 });

  const text = (await readout.innerText()).replace(/\s+/g, ' ').trim();
  expect(text, `heatmap readout must name the subnet: "${text}"`).toMatch(/\d+\.\d+\.\d+\.\d+/);
  expect(text, `heatmap readout must give the utilisation as a %: "${text}"`).toMatch(/%/);
  expect(violations(text), `heatmap readout reads: "${text}"`).toEqual([]);
});

test('heatmap: squares carry an aria-label and no native <title>', async ({ page }) => {
  await page.goto(`/#${HEATMAP.tab}`);
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator(`[data-panel-id="${HEATMAP.panel}"] svg rect`).first())
    .toBeVisible({ timeout: CHART_READY_MS });

  const seen = await page.evaluate((p) => {
    const rects = Array.from(document.querySelectorAll(`[data-panel-id="${p}"] svg rect`));
    return {
      total: rects.length,
      withTitle: rects.filter((r) => r.querySelector('title')).length,
      withoutAria: rects.filter((r) => !r.getAttribute('aria-label')).length,
    };
  }, HEATMAP.panel);

  expect(seen.total, 'no heatmap squares to inspect').toBeGreaterThan(0);
  expect(
    seen.withTitle,
    `${seen.withTitle} of ${seen.total} heatmap squares still carry a native <title>; ` +
      'keeping it alongside the in-app readout draws two tooltips on mouse',
  ).toBe(0);
  expect(
    seen.withoutAria,
    `${seen.withoutAria} of ${seen.total} heatmap squares have no aria-label, so a screen ` +
      'reader loses what <title> was doing',
  ).toBe(0);
});

// Green today. Here so that swapping <title> for a pointer readout cannot
// quietly cost the click that the whole panel exists for.
test('heatmap: clicking a square still opens that subnet on Network', async ({ page }) => {
  await page.goto(`/#${HEATMAP.tab}`);
  await expect(page.locator('h1').first()).toBeVisible();

  const rect = page.locator(`[data-panel-id="${HEATMAP.panel}"] svg rect`).first();
  await expect(rect).toBeVisible({ timeout: CHART_READY_MS });
  await rect.click();
  await expect(page).toHaveURL(/#network\?subnet=/);
});

// ---------------------------------------------------------------------------
// Tap-then-drill (useTapThenDrill, ui/src/tabs/Overview.jsx).
//
// Two panels on Overview carry BOTH a hover readout and a drill-down click:
// Top Consumers' bars and Host Status' slices. A mouse has two gestures for
// that, a finger has one — so on touch the single tap used to fire onClick,
// change the hash and unmount Overview before the tooltip could be read. The
// hook orders the two: on touch, the first tap reveals and a second tap on the
// SAME target navigates; on a mouse nothing changes.
//
// The touch sweep further down CANNOT prove this. It taps a grid of points and
// stops at the first one that answers, so it stays green whether the tooltip
// appeared on tap one or tap five, and it never taps the same target twice.
// These four tests are the ones that hold the hook to its description: without
// them, "the first tap only reveals" and "the second tap still navigates" are
// both untested, and either could regress alone.
// ---------------------------------------------------------------------------

// Where to aim on the 130px donut. Its sectors' bounding boxes include the hole
// in the middle, so the box centre lands on the SVG background and Playwright's
// click is intercepted — the ring itself is a few pixels in from the top edge.
const DONUT_RING_INSET = 10;

test('mouse: the first click on a Top Consumers bar still drills through', async ({ page }) => {
  await page.goto('/#overview');
  const bar = page.locator('[data-panel-id="top-consumers"] .recharts-bar-rectangle path').first();
  await expect(bar).toBeVisible({ timeout: CHART_READY_MS });
  await bar.click();
  await expect(
    page,
    'a mouse must never need two clicks — hover has already shown the value',
  ).toHaveURL(/#network\?subnet=/);
});

test('mouse: the first click on a Host Status slice still drills through', async ({ page }) => {
  await page.goto('/#overview');
  const svg = page.locator('[data-panel-id="host-status"] .recharts-surface').first();
  await expect(svg).toBeVisible({ timeout: CHART_READY_MS });
  await svg.scrollIntoViewIfNeeded();
  const box = (await svg.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + DONUT_RING_INSET);
  await expect(page).toHaveURL(/#infra\?status=/);
});

test.describe('tap-then-drill on a touchscreen', () => {
  test.use({ hasTouch: true });

  test('touch: tap one on a Top Consumers bar reveals, tap two on the same bar drills', async ({ page }) => {
    await page.goto('/#overview');
    const bar = page.locator('[data-panel-id="top-consumers"] .recharts-bar-rectangle path').first();
    await expect(bar).toBeVisible({ timeout: CHART_READY_MS });
    // MUST scroll before reading the box: touchscreen.tap takes viewport
    // coordinates and does not auto-scroll. This panel sits near the fold at
    // 1280x720, and without this the taps land off the bottom of the window and
    // the test reports a silent chart that is in fact fine.
    //
    // Scroll the WRAPPER, not the bar. Scrolling the bar failed once in a full
    // suite run with "Element is not attached to the DOM": /api/data polls every
    // 30s and recharts replaces the whole <path> set on each new payload, so an
    // individual bar is not a stable thing to wait on. The wrapper survives the
    // re-render, and the bar's box is read in one call straight afterwards.
    await page.locator('[data-panel-id="top-consumers"] .recharts-wrapper').first().scrollIntoViewIfNeeded();
    const box = (await bar.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(HOVER_SETTLE_MS * 2);
    expect(
      page.url(),
      'the first tap drilled straight through — the value was never readable on a finger',
    ).not.toMatch(/#network\?subnet=/);
    expect(
      await tooltipText(page, 'top-consumers'),
      'the first tap navigated nowhere AND showed nothing, which is worse than either alone',
    ).not.toBe('');

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(HOVER_SETTLE_MS * 4);
    expect(
      page.url(),
      'the second tap on the same bar must still drill — navigation is one tap away, not gone',
    ).toMatch(/#network\?subnet=/);
  });

  test('touch: tap one on a Host Status slice reveals, tap two on the same slice drills', async ({ page }) => {
    await page.goto('/#overview');
    const svg = page.locator('[data-panel-id="host-status"] .recharts-surface').first();
    await expect(svg).toBeVisible({ timeout: CHART_READY_MS });
    await svg.scrollIntoViewIfNeeded();
    const box = (await svg.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + DONUT_RING_INSET;

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(HOVER_SETTLE_MS * 2);
    expect(page.url(), 'the first tap drilled straight through').not.toMatch(/#infra\?status=/);
    expect(
      await tooltipText(page, 'host-status'),
      'the first tap showed no count, so the donut is unreadable on a finger',
    ).not.toBe('');

    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(HOVER_SETTLE_MS * 4);
    expect(page.url(), 'the second tap on the same slice must still drill').toMatch(/#infra\?status=/);
  });
});

// ---------------------------------------------------------------------------
// Touch. This dashboard gets glanced at from a tablet on a wall mount, where
// hover does not exist — the same reasoning that made the per-panel help a
// disclosure button rather than a title= tooltip (see ui/src/components/ui.jsx,
// above TabIntro). A chart whose only readout needs a mouse has no readout on
// those devices.
// ---------------------------------------------------------------------------

test.describe('with a touchscreen', () => {
  test.use({ hasTouch: true });

  for (const c of CHARTS) {
    test(`touch: tapping "${c.panel}" shows its tooltip`, async ({ page }) => {
      await page.goto(`/#${c.tab}`);
      await expect(page.locator('h1').first()).toBeVisible();

      const startUrl = page.url();
      const box = await chartBox(page, c.panel);
      let text = '';
      let navigatedTo = '';
      for (const fy of YS) {
        for (const fx of XS) {
          await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
          await page.waitForTimeout(HOVER_SETTLE_MS);
          text = await tooltipText(page, c.panel);
          if (text) break;
          // A bar or slice carrying onClick drills through on tap. That is the
          // right behaviour for a mouse, where hover has already shown the
          // number — on a finger it means the value can never be read at all.
          if (page.url() !== startUrl) {
            navigatedTo = page.url();
            break;
          }
        }
        if (text || navigatedTo) break;
      }
      expect(
        text,
        navigatedTo
          ? `tapping "${c.panel}" drilled through to ${navigatedTo} without ever showing the ` +
            'value — on a touchscreen there is no way to read this chart'
          : `tapping every part of "${c.panel}" showed no tooltip — on a touchscreen this ` +
            'chart has no readout at all',
      ).not.toBe('');
      expect(violations(text), `tooltip on "${c.panel}" reads: ${text}`).toEqual([]);
    });
  }

  test('touch: dragging a finger across the heatmap tracks the readout', async ({ page }) => {
    await page.goto(`/#${HEATMAP.tab}`);
    await expect(page.locator('h1').first()).toBeVisible();

    const rect = page.locator(`[data-panel-id="${HEATMAP.panel}"] svg rect`).first();
    await expect(rect).toBeVisible({ timeout: CHART_READY_MS });
    const box = (await rect.boundingBox())!;

    // Pointer events, not touch events: the readout is driven by
    // onPointerEnter/Move, which is the one handler that answers mouse, pen and
    // finger alike. Dispatched rather than tapped so this asserts the handler,
    // not Playwright's tap emulation.
    await page.evaluate(
      ({ p, x, y }) => {
        const el = document.querySelector(`[data-panel-id="${p}"] svg rect`);
        if (!el) return;
        for (const type of ['pointerenter', 'pointerdown', 'pointermove']) {
          el.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerType: 'touch',
              isPrimary: true,
            }),
          );
        }
      },
      { p: HEATMAP.panel, x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );

    const readout = page.locator(`[data-panel-id="${HEATMAP.panel}"] [data-heatmap-readout]`);
    await expect(
      readout,
      'a finger dragged across the heatmap must show the same readout a mouse gets',
    ).toBeVisible({ timeout: 2000 });
    await expect(readout).toContainText('%');
  });
});
