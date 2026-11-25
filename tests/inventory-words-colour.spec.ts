import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 1, job w5b (2026-11-25): Inventory pages' words and colours,
// Overview's button blue, and Threat lookup's ghost edge. Each test here failed
// on the code before the change it covers.

type Page = import('@playwright/test').Page;
const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);
const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);
const failAll = (page: Page) =>
  page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname)
    ? r.fallback()
    : r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream timeout"}' })));

// What a CSS value computes to on this page, read off a throwaway element.
const computed = (page: Page, prop: 'color' | 'backgroundColor', value: string) =>
  page.evaluate(([p, v]) => {
    const el = document.createElement('span');
    el.style[p as 'color'] = v;
    document.querySelector('main')!.appendChild(el);
    const c = getComputedStyle(el)[p as 'color'];
    el.remove();
    return c;
  }, [prop, value]);

// Contrast of a fill (any CSS colour, translucent or not) laid over the card
// colour, measured from the pixel a canvas paints.
const contrastOnCard = (page: Page, fill: string) =>
  page.evaluate((f) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-card)';
    document.body.appendChild(probe);
    const card = getComputedStyle(probe).color;
    probe.style.color = f;
    const fillC = getComputedStyle(probe).color;
    probe.remove();
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d')!;
    const px = (c: string) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = card; cx.fillRect(0, 0, 1, 1); cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = lum(px(card));
    const b = lum(px(fillC));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, fill);

for (const theme of ['dark', 'light']) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('theme', t), theme);
      await installBaselineWorld(page);
    });

    test('A7: Overview\'s main button is the button blue, its text-only actions are link blue, and its secondary buttons are plain', async ({ page }) => {
      await page.goto('/#overview');
      const primary = page.locator('.br a.br-primary');
      await expect(primary).toBeVisible({ timeout: 20_000 });
      expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await computed(page, 'backgroundColor', 'var(--color-accent)'));
      expect(await primary.evaluate((el) => getComputedStyle(el).color)).toBe(await computed(page, 'color', 'var(--color-on-accent)'));
      const link = await computed(page, 'color', 'var(--color-link)');
      const textActions = page.locator('.ov-act');
      expect(await textActions.count()).toBeGreaterThan(0);
      for (const el of await textActions.all()) expect(await el.evaluate((e) => getComputedStyle(e).color)).toBe(link);
      // "View hosts" and Hide are secondary buttons, field-coloured, not the
      // picked tint (GUI audit R2-A8).
      const field = await computed(page, 'color', 'var(--color-field-txt)');
      for (const el of await page.locator('.br a.br-btn, .ov-btn').all()) expect(await el.evaluate((e) => getComputedStyle(e).color)).toBe(field);
    });

    test('B4: a zone problem graded Review is amber on DNS, count and row alike', async ({ page }) => {
      await page.goto('/#dns');
      const n = panel(page, 'dns-zone-kpis').locator('.dns-kind-n').first();
      await expect(n).toBeVisible({ timeout: 20_000 });
      expect(await n.evaluate((el) => getComputedStyle(el).color)).toBe(await computed(page, 'color', 'var(--color-warn)'));
      const row = panel(page, 'dns-zones').locator('tbody tr').filter({ hasText: 'other.example.' });
      const bg = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe(await computed(page, 'backgroundColor', 'color-mix(in srgb, var(--color-warn) 6%, transparent)'));
    });

    test('B13: the healthy green in Network\'s chart and Infra\'s donut reaches 3:1 on the panel', async ({ page }) => {
      await page.goto('/#network');
      const bar = panel(page, 'network-utilization-distribution').locator('.recharts-bar-rectangle path').first();
      await expect(bar).toBeVisible({ timeout: 20_000 });
      const barFill = await bar.evaluate((el) => getComputedStyle(el).fill);
      expect(await contrastOnCard(page, barFill), `bar fill ${barFill}`).toBeGreaterThanOrEqual(3);
      await page.goto('/#infra');
      const slice = panel(page, 'infra-host-status').locator('.recharts-pie-sector path').first();
      await expect(slice).toBeVisible({ timeout: 20_000 });
      const sliceFill = await slice.evaluate((el) => getComputedStyle(el).fill);
      expect(await contrastOnCard(page, sliceFill), `slice fill ${sliceFill}`).toBeGreaterThanOrEqual(3);
    });
  });
}

test.describe('ok state', () => {
  test.beforeEach(async ({ page }) => {
    await installBaselineWorld(page);
  });

  test('E13: Threat lookup draws no shadow edge', async ({ page }) => {
    await page.goto('/#ai');
    const lookup = panel(page, 'ai-threat-lookup');
    await expect(lookup).toBeVisible({ timeout: 20_000 });
    expect(await lookup.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
  });

  test('B9: Network and DNS headline numbers use the shared strip, with no card inside a card', async ({ page }) => {
    for (const tab of ['network', 'dns', 'infra']) {
      await page.goto(`/#${tab}`);
      const strip = page.getByRole('list', { name: 'Headline numbers' });
      await expect(strip).toBeVisible({ timeout: 20_000 });
      await expect(strip, tab).toHaveClass(/\bkpi-strip\b/);
      const pad = await strip.locator('> li').first().evaluate((el) => getComputedStyle(el).padding);
      expect(pad, `${tab} tile cell padding`).toBe('0px');
    }
    // Nothing the old tiles said is lost: Network's explanations and DNS's word.
    await page.goto('/#network');
    await expect(page.getByRole('list', { name: 'Headline numbers' }).getByRole('button', { name: /^≥90% 1$/ }))
      .toHaveAccessibleDescription(/90% full or more/);
    await page.goto('/#dns');
    await expect(page.locator('[data-tile="zones"]')).toContainText('Review');
  });

  test('B12: the results panel has its own name, type rows are filter buttons, bars measure against the total', async ({ page }) => {
    await page.goto('/#assets');
    const list = panel(page, 'assets-list');
    await expect(list.locator('h2')).toBeVisible({ timeout: 20_000 });
    await expect(list.locator('h2')).not.toHaveText(/^Assets$/);
    const bar = panel(page, 'assets-filter-bar');
    const rows = bar.locator('.as-row');
    await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) {
      // A visible cue that the row filters, beside the hover fill.
      await expect(row.locator('.as-cue')).toBeVisible();
      const track = (await row.locator('.as-bar').boundingBox())!;
      const fill = (await row.locator('.as-bar i').boundingBox())!;
      expect(fill.width / track.width, '1 of 2 assets draws half the bar').toBeCloseTo(0.5, 1);
    }
    const first = rows.first();
    const before = await first.evaluate((el) => getComputedStyle(el).backgroundColor);
    await first.hover();
    await expect.poll(() => first.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);
  });

  test('Codex B: the headline asset count and the list agree, or the list says why', async ({ page }) => {
    await page.goto('/#assets');
    const list = panel(page, 'assets-list');
    await expect(list.getByText('baseline-asset-a')).toBeVisible({ timeout: 20_000 });
    await expect(list).toContainText('Infoblox listed 1 asset but counted 2');
  });

  test('Codex B: an empty list under a headline that counted assets says why, not "no assets discovered"', async ({ page }) => {
    await page.route('**/api/csp/assets?*', (r) => r.fulfill({ json: {
      availability: 'ok', dir: 'asc', sort: 'name', page: 1, page_size: 50, has_more: false, total: 0, rows: [],
    } }));
    await page.goto('/#assets');
    const list = panel(page, 'assets-list');
    await expect(list.getByText(/Infoblox's list came back empty but its count says 2 assets/)).toBeVisible({ timeout: 20_000 });
    await expect(list.getByText(/no assets discovered/i)).toHaveCount(0);
  });

  test('Codex B: an empty later page is not read as an empty asset list', async ({ page }) => {
    // Page 1 has a row and more to come, with no total; page 2 comes back empty.
    await page.route('**/api/csp/assets?*', (r) => {
      const first = new URL(r.request().url()).searchParams.get('page') === '0';
      return r.fulfill({ json: {
        availability: 'ok', dir: 'asc', sort: 'name', page_size: 50, total: null,
        has_more: first, rows: first ? [{ cqid: 'cq/p1', name: 'page-one-asset', type: 'Server' }] : [],
      } });
    });
    await page.goto('/#assets');
    const list = panel(page, 'assets-list');
    await expect(list.getByText('page-one-asset')).toBeVisible({ timeout: 20_000 });
    await list.getByRole('button', { name: 'Next' }).click();
    await expect(list.getByText('page-one-asset')).toBeHidden();
    await expect(list.getByText('Nothing more to show.')).toBeVisible();
    await expect(list.getByText(/came back empty/)).toHaveCount(0);
    await expect(list.getByText(/no assets discovered/i)).toHaveCount(0);
    // And the way back is still there.
    await list.getByRole('button', { name: 'Previous' }).click();
    await expect(list.getByText('page-one-asset')).toBeVisible();
  });

  test('B14: a partly working connection says what is wrong in plain words first, the server text under Details', async ({ page }) => {
    await page.goto('/#assets');
    const row = panel(page, 'assets-connectors').locator('li').filter({ hasText: 'baseline-azure' });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText("Some items didn't sync.")).toBeVisible();
    await expect(row.getByText(/Asset Discovery and sync completed/)).toBeHidden();
    await row.getByText('Details').click();
    await expect(row.getByText(/DNS sync has failed partially/)).toBeVisible();
  });

  test('B10: no IT shorthand as a main label on Network, DNS, Infra and Assets', async ({ page }) => {
    const banned: Record<string, RegExp[]> = {
      network: [/IPAM Spaces/, /\bexcl\./, /\bincl\./, /HA pairs/],
      dns: [/DNSSEC Health/, /RPZ Policy Zones/, /DTC Load-Balanced/, /LBDN/, /Pool ID/, /Policy Override/i, /^TTL$/, /^HIGH$/, /^NONE$/, /^Signing$/],
      infra: [/DFP Services/, /^onprem$/, /list cut off/, /not listed/],
      assets: [/NIOS Grid/, /Infoblox Portal discovery/, /^read-only$/, /not in Infoblox Endpoint/],
    };
    for (const [tab, words] of Object.entries(banned)) {
      await page.goto(`/#${tab}`);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState('networkidle');
      // Headings, column heads, table cells, tile labels and plain lines. A
      // panel's short note may still name the Infoblox term ("DNSSEC") as a
      // hint, so the patterns are the old names, not the bare terms.
      const texts = (await page.locator('main h2, main th, main td, main .kpi-label, main p, main [data-tile] span, main span.text-note').allInnerTexts())
        .map((t) => t.trim()).filter(Boolean);
      for (const re of words) expect(texts.filter((t) => re.test(t)), `${tab}: ${re}`).toEqual([]);
    }
  });
});

test.describe('fail state', () => {
  // Two widths. At 1440 on a Mac the subnet table fits 4 of the 6 columns
  // with about 7px to spare; on Linux text is a little wider and it takes a
  // row of its own, which is what CI saw (#524). At 1408 it takes its own row
  // everywhere. A failed read has no table to measure, so before the fix it
  // fell back to 4 columns and moved every panel after it.
  test('Codex B: Network and DNS panels keep their width and place when the reads fail', async ({ page }) => {
    test.setTimeout(150_000);
    for (const width of [1440, 1408]) for (const tab of ['network', 'dns']) {
      await page.setViewportSize({ width, height: 900 });
      const boxes = async () => {
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800);
        return page.locator('[data-card-grid] > [data-panel-id]').evaluateAll((els) =>
          Object.fromEntries(els.map((e) => { const r = e.getBoundingClientRect(); return [e.getAttribute('data-panel-id'), [Math.round(r.x), Math.round(r.width)]]; })));
      };
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await installBaselineWorld(page);
      await page.goto(`/#${tab}`);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 });
      const ok = await boxes();
      await failAll(page);
      await page.goto('about:blank');
      await page.goto(`/#${tab}`);
      await expect(page.locator('main h1').first()).toBeVisible({ timeout: 20_000 });
      const bad = await boxes();
      expect(bad, `${tab} at ${width}: x and width of each panel, fail vs ok`).toEqual(ok);
    }
  });
});
