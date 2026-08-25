import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Page } from '@playwright/test';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// This file sat in playwright.config.ts's LINUX_CI_UNPROVEN_SPECS, described as
// failing on ubuntu for "platform layout/timing" reasons. That description was
// never measured — the one run behind it (31499474048) had NO TENANT as well as
// a different OS, so it could not tell the two apart. Running these same tests
// on macOS through scripts/e2e.sh, which also has no tenant, reproduced most of
// the failures: the missing data was doing the work, not the platform.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// WCAG 2.1 AA, success criterion 1.4.3: normal-size text needs 4.5:1 against its
// background. Every colour in here is read back from getComputedStyle on a real
// element in the running app, never from ui/src/index.css — the declared hex and
// the rendered pixel are not the same thing once opacity, layering and the
// data-theme cascade have had a turn, and it is the rendered pixel that a person
// has to read.
//
// Why this file exists: --color-dim shipped at #777777 (dark) / #6b6b6b (light)
// and --color-tick at #777777 / #999999. Measured against the surfaces they
// actually sit on, that was 3.81:1 for a band caption on bg-line-2, 4.04:1 for a
// 9px caret, 4.11:1 on bg-field, 4.31:1 on a card — and 2.85:1 for an 11px chart
// axis label in light theme. All of it small text. These are the values that
// stop that coming back.
const AA_NORMAL_TEXT = 4.5;

// Injected once per page. Kept as a string because it defines helpers on
// `window` that later page.evaluate calls reuse.
const PROBE = `
(() => {
  const parseRGB = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (o) => 0.2126 * lin(o.r) + 0.7152 * lin(o.g) + 0.0722 * lin(o.b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  // The background a reader actually sees: composite every non-transparent
  // ancestor background down from the page canvas. Reading only the element's
  // own background-color would report "transparent" for almost every span in
  // this app and quietly measure nothing.
  const effBg = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parseRGB(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) stack.push(c);
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  // An ancestor's opacity really does change the rendered colour, so it belongs
  // in the foreground before compositing.
  const cumOpacity = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity || '1');
    return o;
  };
  const hex = (o) => '#' + [o.r, o.g, o.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  const measure = (el, useFill) => {
    const cs = getComputedStyle(el);
    // SVG text (recharts axis labels) carries its colour on \`fill\`, not \`color\`.
    const raw = parseRGB(useFill ? cs.fill : cs.color);
    if (!raw) return null;
    const bg = effBg(useFill ? (el.closest('svg')?.parentElement || el) : el);
    const flat = over({ r: raw.r, g: raw.g, b: raw.b, a: raw.a * cumOpacity(el) }, bg);
    const L1 = lum(flat), L2 = lum(bg);
    return {
      fg: hex(flat),
      bg: hex(bg),
      fontSizePx: parseFloat(cs.fontSize),
      // TWO RATIOS ON PURPOSE. 'ratio' was rounded to two decimals and then
      // compared against 4.5, so a real 4.495 read as 4.50 and passed — the
      // rounding, not the palette, decided it. Comparisons use 'exact'; 'ratio'
      // is the rounded one and exists only so the failure message is readable.
      //
      // Single quotes, not backticks: this whole block lives inside the PROBE
      // template literal below, and a backtick here ends the string.
      ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100,
      exact: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05),
      text: (el.textContent || '').trim().slice(0, 32),
    };
  };

  // A token measured against a token: proves the palette itself, independent of
  // whether any given screen happens to render that combination today.
  window.__tokenPair = (token, bgToken) => {
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    probe.textContent = 'x';
    probe.style.color = root.getPropertyValue(token).trim();
    probe.style.backgroundColor = root.getPropertyValue(bgToken).trim();
    document.body.appendChild(probe);
    const r = measure(probe, false);
    probe.remove();
    return r;
  };

  // Every visible element carrying one of the quiet-text classes, deduped by
  // rendered colour pair so the report names distinct failures, not 500 copies.
  window.__sweep = (selector, useFill) => {
    const els = [...document.querySelectorAll(selector)]
      .filter((e) => (e.textContent || '').trim() && e.getClientRects().length);
    const seen = new Map();
    for (const e of els.slice(0, 600)) {
      const r = measure(e, useFill);
      if (!r) continue;
      const k = r.fg + '|' + r.bg + '|' + r.fontSizePx;
      if (!seen.has(k)) seen.set(k, { ...r, count: 0 });
      seen.get(k).count++;
    }
    return [...seen.values()].sort((a, b) => a.ratio - b.ratio);
  };
  return true;
})()
`;

type Sample = {
  fg: string;
  bg: string;
  fontSizePx: number;
  ratio: number;
  exact: number;
  text: string;
  count?: number;
};

const QUIET_TEXT = '.text-dim, .text-muted, thead th';

// Every panel on these four screens renders `Skeleton` (ui.jsx) while its own
// fetch is in flight, so the number of skeletons still on the page is the app
// itself saying how many panels have not answered yet. Zero of them is the
// only honest definition of "this page has finished loading".
//
// It has to be the loading state and NOT a settled element count, which is the
// bug this loop was rewritten for. Counts polled every 250ms after goto,
// default viewport, live tenant on :8090, as [quiet-text, skeletons]:
//
//   #overview  0.05s [0,0]  0.30s [346,2]  1.34s [346,1]  2.62s [361,0]
//   #assets    0.05s [0,0]  0.30s [ 64,1]                 5.61s [ 71,0]
//   #changes   0.05s [0,0]  0.30s [ 20,2]                 0.81s [1544,0]
//   #dossier   0.04s [0,0]  0.30s [ 43,1]  2.83s [ 43,1]  3.58s [ 78,0]
//
// Read the middle column: on all four routes the count sits still for seconds
// while a skeleton is still on screen. #assets held 64 for 5.3s (and 19 for
// 5.6s on a cold cache), #changes held 20, #dossier held 43. Three equal reads
// 250ms apart — 750ms — are satisfied by every one of those plateaus, which is
// exactly how the old loop came back with 14 for #assets and swept a shell.
// The skeleton count is 0 only at the instant the real content lands, on all
// four. The 11.5px actor and kind columns this file exists for are in the 1524
// that arrive at 0.81s on #changes, not the 20 that are there at 0.30s.
//
// Deliberately NOT a per-route element floor, which was tried first and is the
// wrong instrument here. #assets is upstream-variable: /api/csp/asset-filters
// returns anywhere from 0 to 49 type chips for the same tenant (observed 0 at
// 06:01 and 22 at 06:06 on 2026-08-07, both availability "ok" with the same
// total of 2374), and each chip carries two quiet-text elements. So a fully
// loaded #assets is 28, 71 or 126 elements depending on nothing the test
// controls, and its shell is 19–20. There is no number that separates those.
// The skeleton count separates them cleanly, and needs no per-route constant.
//
// The per-route floors added further down on 2026-08-07 do not contradict this
// and do not replace it. They are not a loaded-ness test: they are never
// consulted until settle() has already returned, and they only catch a settled
// page that yielded almost nothing to measure. The instrument for "has this
// finished loading" is still, only, the skeleton count — which is why the
// #assets shell still measures 17 (re-measured 2026-08-07 with the csp calls
// held open) and is still caught here rather than by any floor.
const LOADING = '.animate-pulse';

// Three consecutive equal reads, not two: an earlier two-read version accepted
// #changes at 15 elements when two polls happened to straddle the pre-data
// plateau, and passed having measured almost nothing. Three also absorbs the
// one-element drift on #dossier (78 → 79 on a re-render) without waiting for
// the full timeout. Kept alongside the skeleton gate rather than replaced by
// it: a panel can finish loading and still re-render once more.
const STABLE_READS = 3;

const POLL_MS = 250;
// 30s per route, up from 15s. Cold #assets took 7.4s and 8.4s to reach zero
// skeletons on two separate reads with the server's 300s cache (go/internal/
// cache) expired, on an IDLE machine — and the full suite is the busy case,
// which is exactly why this spec passed alone and failed in a full run. 15s
// left under 7s of headroom on the one route that uses it. A healthy route
// still costs only as long as it actually takes, because the loop returns on
// the first stable read with no skeletons left; the extra budget is only ever
// spent by a page that is genuinely slow, and a page that never finishes now
// fails by name instead of being swept as a shell.
const SETTLE_TIMEOUT_MS = 30_000;

async function settle(page: Page, route: string) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = -1;
  let repeats = 0;
  let n = 0;
  let skeletons = 0;
  while (Date.now() < deadline) {
    [n, skeletons] = await page.evaluate(
      ([quiet, loading]) => [
        document.querySelectorAll(quiet).length,
        document.querySelectorAll(loading).length,
      ],
      [QUIET_TEXT, LOADING],
    );
    // n > 0 keeps the pre-mount frame — where the count and the skeleton count
    // are both legitimately 0 — from reading as a loaded page.
    repeats = n > 0 && n === last ? repeats + 1 : 0;
    if (skeletons === 0 && repeats >= STABLE_READS - 1) return n;
    last = n;
    await page.waitForTimeout(POLL_MS);
  }
  // Two different failures, and telling them apart is the whole point of
  // failing here instead of sweeping whatever happened to be on screen.
  throw new Error(
    skeletons > 0
      ? `${route} still had ${skeletons} panel(s) loading after ${SETTLE_TIMEOUT_MS}ms ` +
        `(${n} quiet-text elements on screen). The page never finished; sweeping it ` +
        `now would measure a shell and report it green, which is the bug this guard ` +
        `exists for. Raise SETTLE_TIMEOUT_MS only with a measurement showing the page ` +
        `genuinely needs longer.`
      : `${route} finished loading but its element count never held still for ` +
        `${STABLE_READS} consecutive reads inside ${SETTLE_TIMEOUT_MS}ms (last read ` +
        `${n}). The page is still re-rendering, so a sweep would measure a moving target.`,
  );
}

// ui.jsx's FeedUnavailable, the panel a failed fetch renders. It draws NO
// skeleton, so settle() legitimately returns on a page whose feeds all failed:
// nothing is loading any more. The attribute carries the panel's label.
const FEED_UNAVAILABLE = '[data-feed-unavailable]';

// A dead feed here is a client-side timeout, not a broken build. ui/src/lib/
// api.js aborts a request at COLD_TIMEOUT_MS = 12000 and useApi has no retry,
// so one slow read under full-suite load poisons that page load permanently —
// measured on 2026-08-07: `npx playwright test contrast --repeat-each=5` put
// #assets into "Asset filter feed unavailable / Asset inventory unavailable —
// signal is aborted without reason" on 1 of 30 tests. A fresh load is the only
// recovery the app offers, and the server does NOT come back warmer for it:
// cache.Do (go/internal/cache/cache.go:204) stores only on err == nil, and an
// aborted request cancels r.Context() so the fetch it was leading returns an
// error and caches nothing. The reload wins by getting a fresh 12s budget
// after the load spike, not by hitting a warm entry — which is why two of them
// with a pause between is the shape, rather than an immediate retry.
const RECOVERY_RELOADS = 2;
const RECOVERY_PAUSE_MS = 1_000;

/** Every FeedUnavailable panel currently on screen, with its label and reason. */
async function unavailableFeeds(page: Page): Promise<Array<{ label: string; reason: string }>> {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => {
      const kids = [...el.children];
      return {
        label: el.getAttribute('data-feed-unavailable') || '(unlabelled)',
        // FeedUnavailable renders the reason as a second child, or omits it.
        reason: kids.length > 1 ? (kids[kids.length - 1].textContent || '').trim() : '',
      };
    });
  }, FEED_UNAVAILABLE);
}

async function open(page: Page, theme: 'dark' | 'light', route: string) {
  await page.addInitScript(`localStorage.setItem('theme', ${JSON.stringify(theme)})`);
  await page.goto('/' + route);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await settle(page, route);
  for (let i = 0; i < RECOVERY_RELOADS && (await unavailableFeeds(page)).length > 0; i++) {
    await page.waitForTimeout(RECOVERY_PAUSE_MS);
    await page.reload();
    await settle(page, route);
  }
  await page.evaluate(PROBE);
}

const describe = (where: string, s: Sample) =>
  `${where}: ${s.ratio}:1 — ${s.fg} on ${s.bg} at ${s.fontSizePx}px` +
  `${s.count ? ` (×${s.count})` : ''}${s.text ? ` — "${s.text}"` : ''}`;

// Only combinations observed rendering in the live app are asserted here.
// Asserting a pair the app never produces would be a test of arithmetic, not of
// the product.
const TOKEN_PAIRS: Array<[string, string]> = [
  ['--color-dim', '--color-card'],
  ['--color-dim', '--color-bg'],
  ['--color-dim', '--color-field'],
  ['--color-dim', '--color-line'],
  ['--color-dim', '--color-line-2'],
  ['--color-muted', '--color-card'],
  ['--color-muted', '--color-bg'],
  ['--color-muted', '--color-field'],
  ['--color-tick', '--color-card'],
  ['--color-tick', '--color-bg'],
  // THE FILLED BUTTONS, which this list did not reach until now.
  //
  // Every pair above is quiet text on a SURFACE. The three filled buttons —
  // Preview/Apply in ui.jsx, Check drift, the armed Delete — put a label on a
  // SEMANTIC fill instead, and they were all hard-coded `color: '#fff'`.
  // Measured, which is why they are here: white was 3.79:1 on dark crit,
  // 1.74:1 on dark ok and 3.30:1 on light ok. Three AA failures that a list of
  // text-on-surface pairs is structurally unable to see.
  //
  // The labels are text-sm, i.e. normal text, so 4.5:1 is the right bar.
  ['--color-on-accent', '--color-accent'],
  ['--color-on-crit', '--color-crit'],
  ['--color-on-ok', '--color-ok'],
];

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} theme: quiet-text tokens clear AA against every surface they sit on`, async ({ page }) => {
    await open(page, theme, '#overview');

    const failures: string[] = [];
    for (const [token, bgToken] of TOKEN_PAIRS) {
      const s = (await page.evaluate(
        ([t, b]) => (window as any).__tokenPair(t, b),
        [token, bgToken],
      )) as Sample | null;
      expect(s, `${token} on ${bgToken} produced no measurement`).not.toBeNull();
      if ((s as Sample).exact < AA_NORMAL_TEXT) {
        failures.push(describe(`${token} on ${bgToken}`, s as Sample));
      }
    }
    expect(failures, `below ${AA_NORMAL_TEXT}:1 in ${theme} theme:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  test(`${theme} theme: rendered small text clears AA on the screens that use it`, async ({ page }) => {
    // Four routes, each with its own 30s settle budget. Playwright's default
    // 30s per-test timeout would fire partway through #assets on a cold cache
    // and report "Test timeout of 30000ms exceeded" — which names neither the
    // route nor the count it got to — instead of settle()'s message, which
    // names both. This is a ceiling, not a cost: the healthy run below still
    // finishes in seconds.
    test.setTimeout(150_000);
    // #changes carries the actor and kind columns at 11.5px and the band
    // captions; #dossier carries the lane labels; #overview and #assets are the
    // dense screens that were never part of the build this fix came out of.
    //
    // The second number is the "we measured almost nothing" floor, per route,
    // because the four routes are nowhere near the same size and one constant
    // for all of them either blinds three screens or flakes on the fourth.
    // Route and floor live in one literal so they cannot drift apart.
    //
    // Measured 2026-08-07 against :8090, warm, 3 reads per route per theme,
    // identical in dark and light (a standalone driver replaying settle() and
    // __sweep's own visible/non-empty filter):
    //
    //   #overview 365 · #changes 600 (the sweep's own 600-element cap) ·
    //   #dossier 75 · #assets 125
    //
    // #assets is the one that needs its own number, and these are the states
    // that number has to separate — same driver, same day:
    //
    //   17  both /api/csp feeds aborted, zero skeletons  -> MUST fail
    //   17  shell, both panels still loading             -> settle() catches it
    //   24  only /api/csp/asset-filters aborted          -> feeds named, passes
    //   26  filters ok but zero type chips, table loaded -> MUST pass
    //   125 healthy, 22 type chips                       -> passes
    //
    // 20 is the only kind of number that fits: above the 17 this spec flaked on
    // (1 of 30 on --repeat-each=5, dark #assets, both panels FeedUnavailable)
    // and six clear of the thinnest page that has genuinely loaded. The
    // zero-chip 26 is the gap the old comment here documented and left open;
    // it is closed now. A FLAT 20 for all four routes was rejected: it would
    // let a 21-element partial render pass on screens whose loaded counts are
    // 365-600, which is exactly the "green run that measured nothing" this
    // backstop exists to prevent.
    //
    // What this deliberately does NOT do: fail because a feed is unavailable
    // while still leaving enough quiet text to measure (the 24 row above). This
    // file grades contrast; tests/failure-not-absence-*.spec.ts grades
    // availability, and duplicating that here would add a new flake surface on
    // all four routes to fix one on #assets.
    const routes: Array<[route: string, floor: number]> = [
      ['#overview', 40],
      ['#assets', 20],
      ['#changes', 40],
      ['#dossier?q=172.16.128.1', 40],
    ];
    const failures: string[] = [];

    for (const [route, floor] of routes) {
      await open(page, theme, route);
      // The quiet-text family only. Other colours (accent links, severity pills)
      // are a separate question and are not what this file locks down.
      const samples = (await page.evaluate(
        (s) => (window as any).__sweep(s, false),
        QUIET_TEXT,
      )) as Sample[];
      expect(samples.length, `${route} rendered no quiet text to measure`).toBeGreaterThan(0);
      // Guards against a green run that measured nothing: the sample rows are
      // deduped by colour pair, so this counts the elements behind them. This
      // is the backstop, not the fix — settle() is what proves nothing is
      // still loading before we get here.
      const scanned = samples.reduce((n, s) => n + (s.count ?? 0), 0);
      if (scanned <= floor) {
        // The message is built only on the failing path, and it has to say
        // WHICH of the two things went wrong, because the old wording said the
        // wrong one: "page had not loaded" was printed about a page that had
        // loaded, into two FeedUnavailable panels, after settle() correctly
        // saw zero skeletons. Never again — either the feeds are named, or the
        // message states that no feed reported a failure.
        const dead = await unavailableFeeds(page);
        const why = dead.length
          ? `The page LOADED and its feeds did not answer: ${dead.length} panel(s) still ` +
            `unavailable after ${RECOVERY_RELOADS} reload(s) — ` +
            dead.map((d) => `${d.label} (${d.reason || 'no reason rendered'})`).join('; ') +
            `. That is an upstream/timeout failure, not a contrast regression.`
          : `No panel reported a failed feed, so this is a genuinely thin render — ` +
            `fewer quiet-text elements than any loaded ${route} has been measured at.`;
        expect(
          scanned,
          `${route} scanned only ${scanned} elements, at or below its floor of ${floor}. ${why}`,
        ).toBeGreaterThan(floor);
      }
      for (const s of samples) {
        if (s.exact < AA_NORMAL_TEXT) failures.push(describe(`${theme} ${route}`, s));
      }
    }
    expect(failures, `below ${AA_NORMAL_TEXT}:1:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  test(`${theme} theme: chart axis labels clear AA`, async ({ page }) => {
    // These are 11px <text> nodes, i.e. normal-size text, and they were the
    // worst offender in light theme at 2.85:1.
    await open(page, theme, '#overview');
    await page.locator('.recharts-cartesian-axis-tick-value').first().waitFor({ state: 'attached' });
    const samples = (await page.evaluate(
      () => (window as any).__sweep('.recharts-cartesian-axis-tick-value', true),
    )) as Sample[];

    expect(samples.length, 'no chart axis labels rendered').toBeGreaterThan(0);
    const failures = samples
      .filter((s) => s.exact < AA_NORMAL_TEXT)
      .map((s) => describe(`${theme} #overview axis tick`, s));
    expect(failures, `below ${AA_NORMAL_TEXT}:1:\n  ${failures.join('\n  ')}`).toEqual([]);
  });
}
