import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The keyboard, colour and reading audit of 2026-11-23. Every /api/ response is
// faked, so nothing here reaches a tenant.

const focusedIs = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement?.matches(s), selector);

async function open(page: Page, hash: string, ready = 'main h1') {
  await installBaselineWorld(page);
  await page.addInitScript(() => localStorage.setItem('bloxsmith.nav.open', JSON.stringify(['status', 'inventory', 'risk', 'change', 'ask'])));
  await page.goto(`/#${hash}`);
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
}

// WCAG contrast of two computed colours, the foreground laid over the background.
const contrastOf = (page: Page, fg: string, bg: string) =>
  page.evaluate(([f, b]) => {
    const paint = (value: string, under?: number[]) => {
      const c = document.createElement('canvas').getContext('2d')!;
      if (under) { c.fillStyle = `rgb(${under.join(',')})`; c.fillRect(0, 0, 1, 1); }
      c.fillStyle = value;
      c.fillRect(0, 0, 1, 1);
      return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const lum = (rgb: number[]) => {
      const [r, g, b2] = rgb.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
    };
    const back = paint(b);
    const [hi, lo] = [lum(paint(f, back)), lum(back)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }, [fg, bg]);

const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

test.describe('side menu', () => {
  for (const [name, use] of [
    ['with a mouse', { viewport: { width: 1440, height: 900 } }],
    ['on a touch screen', { viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true }],
  ] as const) {
    test.describe(name, () => {
      test.use(use);

      test('Shift+Tab from the page top reaches the last link of an open group, and Tab returns', async ({ page }) => {
        await open(page, 'overview');
        const last = page.locator('.frame-rail .frame-sublink').last();
        await expect(last).toHaveCount(1);
        await page.locator('.frame-top').locator('a:visible,button:visible,input:visible').first().focus();
        await page.keyboard.press('Shift+Tab');
        await expect(last).toBeFocused();
        await page.keyboard.press('Tab');
        expect(await focusedIs(page, '.frame-top *')).toBe(true);
      });
    });
  }
});

test.describe('tips', () => {
  for (const width of [320, 390, 1440]) {
    test(`no tip crosses a screen edge at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      for (const hash of ['overview', 'daily', 'audit']) {
        await open(page, hash, '.ov-tipwrap, .dy-tipwrap');
        await page.keyboard.press('Tab');
        const bad = await page.evaluate(async () => {
          const out: string[] = [];
          for (const wrap of document.querySelectorAll<HTMLElement>('.ov-tipwrap, .dy-tipwrap')) {
            wrap.focus();
            await new Promise(requestAnimationFrame);
            const tip = wrap.querySelector<HTMLElement>(':scope > [role="tooltip"]');
            if (!tip || getComputedStyle(tip).display === 'none') continue;
            const r = tip.getBoundingClientRect();
            if (r.left < 0 || r.right > document.documentElement.clientWidth) out.push(`${Math.round(r.left)}..${Math.round(r.right)} ${tip.textContent?.slice(0, 30)}`);
          }
          return out;
        });
        expect(bad, hash).toEqual([]);
      }
    });
  }

  test('the pointer can move from the word onto its tip without the tip closing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'overview', '.ov-day');
    const day = page.locator('.ov-day').first();
    await day.scrollIntoViewIfNeeded();
    await day.hover();
    const tip = day.getByRole('tooltip');
    await expect(tip).toBeVisible();
    const t = (await tip.boundingBox())!;
    const d = (await day.boundingBox())!;
    await page.mouse.move(d.x + d.width / 2, d.y - 4, { steps: 3 });
    await expect(tip).toBeVisible();
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 3 });
    await expect(tip).toBeVisible();
  });
});

test.describe('200% zoom', () => {
  test.use({ viewport: { width: 720, height: 450 } });
  for (const hash of ['network', 'dns', 'assets', 'infra', 'security', 'incidents']) {
    test(`no Tab stop on ${hash} is fully covered by a sticky header`, async ({ page }) => {
      await open(page, hash);
      await page.locator('main').focus();
      const covered: string[] = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        const hit = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body || !el.closest('main')) return null;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return null;
          const xs = [r.left + 1, r.left + r.width / 2, r.right - 1];
          const ys = [r.top + 1, r.top + r.height / 2, r.bottom - 1];
          let seen = false;
          for (const x of xs) for (const y of ys) {
            const at = document.elementFromPoint(x, y);
            if (at && (el === at || el.contains(at) || at.contains(el))) seen = true;
          }
          return seen ? '' : `${el.tagName} ${(el.getAttribute('aria-label') || el.textContent || '').slice(0, 30)}`;
        });
        if (hit) covered.push(hit);
      }
      expect(covered).toEqual([]);
    });
  }
});

test.describe('Ask', () => {
  test('the question box shows the focus ring from the keyboard', async ({ page }) => {
    await open(page, 'ai');
    const box = page.getByRole('textbox', { name: 'Ask about your network' });
    await box.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(box).toBeFocused();
    const shadow = await box.locator('..').evaluate((el) => getComputedStyle(el).boxShadow);
    expect(shadow).not.toBe('none');
    await expect(box).toHaveAttribute('placeholder', 'Ask a question…');
  });

  test('Lookup stays inside its card at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await open(page, 'ai');
    const button = page.getByRole('button', { name: 'Lookup', exact: true });
    const card = button.locator('xpath=ancestor::*[@data-panel-id or contains(@class,"rounded-surface")][1]');
    const b = (await button.boundingBox())!;
    const c = (await card.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(c.x + c.width);
  });

  test('a failed lookup is announced', async ({ page }) => {
    await open(page, 'ai');
    await page.route('**/api/threat-lookup*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"lookup failed"}' }));
    await page.getByRole('textbox', { name: 'Look up a domain, IP, or host' }).fill('bad.example');
    await page.getByRole('button', { name: 'Lookup', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'lookup failed' })).toBeVisible({ timeout: 15_000 });
  });
});

test('a warning day differs from a critical day by more than colour', async ({ page }) => {
  await open(page, 'overview', '.ov-day');
  await page.evaluate(() => {
    const host = document.querySelector('.ov-strip')!;
    host.insertAdjacentHTML('beforeend', '<span id="w" class="ov-day warn"></span><span id="c" class="ov-day crit"></span>');
  });
  const image = (id: string) => page.locator(id).evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(await image('#w')).toContain('gradient');
  expect(await image('#c')).toBe('none');
});

test('a day tile with an open problem names its severity first', async ({ page }) => {
  await open(page, 'overview', '.ov-day');
  const tips = await page.locator('.ov-day.crit [role="tooltip"], .ov-day.warn [role="tooltip"]').allTextContents();
  expect(tips.length).toBeGreaterThan(0);
  for (const t of tips) expect(t).toMatch(/^(Warning|Critical)\b/);
});

test('status and severity colours read at 4.5:1 in both themes', async ({ page }) => {
  await open(page, 'overview');
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme);
    const pairs: [string, string][] = [
      ['--color-sev-high', '--color-card'],
      ['--color-sev-high', '--color-bg'],
      ['--color-muted', '--color-card'],
      ['--color-link', '--color-card'],
      ['--pill-crit-fg', '--pill-crit-bg'],
      ['--pill-warn-fg', '--pill-warn-bg'],
      ['--pill-neutral-fg', '--pill-neutral-bg'],
      ['--color-on-crit', '--color-crit'],
    ];
    for (const [fg, bg] of pairs) {
      const ratio = await contrastOf(page, await token(page, fg), await token(page, bg));
      expect(ratio, `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('the Best Practices critical mark uses the on-critical text colour', async ({ page }) => {
  await open(page, 'best-practices');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<span id="ring" class="bp-ring crit">!</span>'));
  const ring = await page.locator('#ring').evaluate((el) => getComputedStyle(el).color);
  const onCrit = await page.evaluate(() => {
    const p = document.createElement('i');
    p.style.color = 'var(--color-on-crit)';
    document.body.append(p);
    return getComputedStyle(p).color;
  });
  expect(ring).toBe(onCrit);
});

test('links are underlined in the light theme too', async ({ page }) => {
  await open(page, 'overview');
  await setTheme(page, 'light');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<a id="l" class="text-link" href="#overview">x</a>'));
  expect(await page.locator('#l').evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('underline');
});

test('Security: the events panel is by hour, with plain totals and no colour key', async ({ page }) => {
  await open(page, 'security');
  const card = page.locator('[data-panel-id="security-threat-events"]');
  await expect(card.getByRole('heading', { name: 'Threat Events by hour' })).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('High', { exact: false }).first()).toBeVisible();
  await expect(card.locator('i.rounded-mark')).toHaveCount(0);
});

test('Security: Threat Feed Activity has a colour key beside each total', async ({ page }) => {
  await open(page, 'security');
  const card = page.locator('[data-panel-id="security-threat-feed-activity"]');
  await expect(card.getByText('Blocked')).toBeVisible({ timeout: 20_000 });
  await expect(card.locator('[data-swatch]')).toHaveCount(2);
});

test('Automate: a chosen job has no side stripe', async ({ page }) => {
  await open(page, 'automate');
  const job = page.getByRole('navigation', { name: 'Jobs to automate' }).getByRole('button').first();
  await job.click();
  await expect(job).toHaveAttribute('aria-pressed', 'true');
  expect(await job.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');
});

test('Assets: sorting keeps keyboard focus on the column heading', async ({ page }) => {
  await open(page, 'assets', 'table');
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/csp/assets*', async (route) => { await held; await route.fallback(); });
  const head = page.getByRole('columnheader', { name: /Name/ }).first();
  const sorter = head.locator('button').first();
  const target = (await sorter.count()) ? sorter : head;
  await target.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main table').first()).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('th'))).toBe(true);
  release();
});

test('Assets: opening a row moves focus to its detail', async ({ page }) => {
  await open(page, 'assets', 'table');
  await page.getByText('baseline-asset-a').first().click();
  const detail = page.locator('[data-panel-id="assets-detail"]');
  await expect(detail).toBeVisible();
  await expect.poll(() => detail.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

test('Incidents: each acknowledge box names its item', async ({ page }) => {
  await open(page, 'incidents');
  await expect(page.getByRole('checkbox', { name: 'Acknowledge ipam/subnet/baseline-3' })).toBeVisible({ timeout: 20_000 });
});

test('Skip to content is the first Tab stop and moves focus to the page', async ({ page }) => {
  await open(page, 'overview');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  const skip = page.getByRole('button', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  const hash = await page.evaluate(() => location.hash);
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  expect(await page.evaluate(() => location.hash)).toBe(hash);
});
