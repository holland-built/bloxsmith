import { test, expect, EGRESS_OK_KEY } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// "This help stuff needs a way better way to display app wide." Each page now
// opens with one sentence, and a Help button in the same place on every page
// opens that page's help. The AI privacy notice is asked once, not shown loud
// on every visit, and nothing is sent before it is understood.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

for (const [hash, heading] of [['#editor', 'Editor'], ['#ai', 'AI'], ['#drift', 'Compare to template'], ['#overview', 'Overview']] as const) {
  test(`${heading}: one sentence under the title, and Help opens this page's help`, async ({ page }) => {
    await page.goto('/' + hash);
    await expect(page.getByRole('button', { name: 'Docs' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Help for this page' }).click();
    const panel = page.getByRole('dialog');
    await expect(panel.getByRole('heading', { level: 2, name: `Help: ${heading}`, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Help for this page' })).toBeFocused();
  });
}

for (const [width, height, bar] of [[1440, 900, '.frame-rail'], [390, 844, '.frame-dock']] as const) {
  test(`Help opens above the page navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/#overview');
    const nav = page.locator(bar);
    await expect(nav).toBeVisible();
    await page.getByRole('button', { name: 'Help for this page' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const onTop = await nav.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(onTop, 'the navigation must not sit above the open Help').toBe(false);
  });
}

test('Refresh now pauses every refresh button, not only the one pressed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  await page.locator('.frame-tools').getByRole('button', { name: 'Refresh now' }).click();
  await page.locator('.frame-menu-btn').click();
  await expect(page.locator('.frame-menu-foot').getByRole('button', { name: 'Refresh now' })).toBeDisabled();
});

test('nothing is sent to the AI until the notice is understood, then it shrinks to a line', async ({ page }) => {
  // Once per test, so the reload below keeps what Understood saved.
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('cleared')) { localStorage.removeItem(key); sessionStorage.setItem('cleared', '1'); }
  }, EGRESS_OK_KEY);
  const asked: string[] = [];
  await page.route('**/api/query', (r) => { asked.push(r.request().postDataJSON().question); return r.fulfill({ json: { answer: 'ok' } }); });
  await page.goto('/#ai?q=' + encodeURIComponent('Which hosts are offline?'));
  const box = page.getByRole('textbox', { name: 'Ask about your network' });
  await expect(page.getByRole('note')).toContainText('to Groq (api.groq.com). Nothing is sent until you ask.');
  await expect(box).toHaveValue('Which hosts are offline?');
  await box.press('Enter');
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'Allow AI questions' }).click();
  await expect(page.getByText('Questions send details from this account to Groq.')).toBeVisible();
  await box.press('Enter');
  await expect.poll(() => asked).toEqual(['Which hosts are offline?']);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Allow AI questions' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('note')).toContainText('Nothing is sent until you ask.');
});

test('a different AI provider asks again', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify(['api.groq.com'])), EGRESS_OK_KEY);
  await page.route('**/api/vault/status', async (r) => {
    const res = await r.fetch().catch(() => null);
    const base = res ? await res.json().catch(() => ({})) : {};
    return r.fulfill({ json: { ...base, active: 'baseline-tenant', unlocked: true, ready: true, exists: true, llmSendsTo: 'llm.example.net' } });
  });
  await page.goto('/#ai');
  await expect(page.getByRole('note')).toContainText('to the AI service at llm.example.net.');
  await expect(page.getByRole('button', { name: 'Allow AI questions' })).toBeVisible();
});

test('when the AI address cannot be read, nothing can be sent', async ({ page }) => {
  await page.route('**/api/vault/status', async (r) => {
    const res = await r.fetch().catch(() => null);
    const base = res ? await res.json().catch(() => ({})) : {};
    return r.fulfill({ json: { ...base, active: 'baseline-tenant', unlocked: true, ready: true, exists: true, llmSendsTo: '' } });
  });
  let sent = 0;
  await page.route('**/api/query**', (r) => { sent++; return r.abort(); });
  await page.goto('/#ai');
  await expect(page.getByRole('note')).toContainText('could not be read');
  await expect(page.getByRole('button', { name: 'Allow AI questions' })).toBeDisabled();
  const box = page.getByRole('textbox', { name: 'Ask about your network' });
  await box.fill('Which hosts are offline?');
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(sent).toBe(0);
  await expect(box).toHaveValue('Which hosts are offline?');
});
