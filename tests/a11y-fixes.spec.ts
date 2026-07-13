import { test, expect } from '@playwright/test';

// a11y token/ARIA fixes (3 targeted). Mirrors the sibling specs' harness:
// mocked backend, NOC_BASE-overridable base URL. Covers:
//  M1 — multi-sort priority badge (.sort-order) uses tokens, not raw #fff / sub-11px.
//  M2 — the DataTable exposes a valid grid + aria-activedescendant → row relationship.
//  M3 — a useHoverDetail().bind()-ed control exposes its description to the a11y tree.

test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

const DATA = {
  subnets: [
    { id: 's-a', name: 'Alpha Net', addr: '10.10.10.0', cidr: 24, util: 95, site: 'HQ' },
    { id: 's-b', name: 'Beta Net',  addr: '10.20.20.0', cidr: 24, util: 88, site: 'DR' },
    { id: 's-c', name: 'Gamma Net', addr: '10.30.30.0', cidr: 24, util: 80, site: 'BR' },
  ],
  leases: [], zones: [], hosts: [], auditLogs: [],
};

async function stub(page) {
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/vault/status', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ vaultMode: false }) }));
  await page.route('**/api/whoami', route =>
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ role: 'admin' }) }));
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) }));
}

// ── M1 ────────────────────────────────────────────────────────────────────
test('M1: .sort-order badge colors + sizes from design tokens, not raw #fff / 9px', async ({ page }) => {
  await stub(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });

  // Inspect the authored CSS rule (computed color can't tell a token whose value
  // IS #fff apart from a literal #fff — so assert the *specified* value uses var()).
  const rule = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules) as CSSStyleRule[]) {
        if (r.selectorText && r.selectorText.includes('.sort-order')) {
          return { color: r.style.color, fontSize: r.style.fontSize };
        }
      }
    }
    return null;
  });
  expect(rule, '.sort-order CSS rule must exist').not.toBeNull();
  // color is a token, not a raw hex.
  expect(rule!.color).toContain('var(');
  expect(rule!.color).not.toMatch(/#fff|#ffffff|rgb/i);
  // font-size is a token…
  expect(rule!.fontSize).toContain('var(');

  // …and that token resolves to at least 11px (above the sub-floor).
  const px = await page.evaluate(() => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--t11').trim();
    return parseFloat(raw);
  });
  expect(px).toBeGreaterThanOrEqual(11);
});

// ── M2 ────────────────────────────────────────────────────────────────────
test('M2: DataTable exposes role=grid + aria-activedescendant → a role=row, aria-selected row', async ({ page }) => {
  await stub(page);
  await page.goto('/#network');

  const wrap = page.locator('div[role="grid"]:has(tr.clickable)');
  await expect(wrap.locator('tr.clickable').first()).toBeVisible();
  await wrap.focus();
  await page.keyboard.press('j'); // move the vim cursor onto a row

  const rel = await wrap.evaluate((el) => {
    const ad = el.getAttribute('aria-activedescendant');
    const target = ad ? document.getElementById(ad) : null;
    return {
      role: el.getAttribute('role'),
      ad,
      targetExists: !!target,
      targetTag: target ? target.tagName : null,
      targetRole: target ? target.getAttribute('role') : null,
      targetSelected: target ? target.getAttribute('aria-selected') : null,
    };
  });

  expect(rel.role).toBe('grid');                 // composite role makes activedescendant valid
  expect(rel.ad).toBeTruthy();                   // points at the cursor row
  expect(rel.targetExists).toBe(true);           // …and that id resolves
  expect(rel.targetTag).toBe('TR');
  expect(rel.targetRole).toBe('row');            // valid grid row (was role=button)
  expect(rel.targetSelected).toBe('true');       // aria-selected now honored on a row
});

// ── M3 ────────────────────────────────────────────────────────────────────
test('M3: a bind()-ed control carries its hover copy as an accessible description', async ({ page }) => {
  await stub(page);
  await page.goto('/#overview', { waitUntil: 'networkidle' });

  // The section nav buttons are always present and bound via useHoverDetail().
  const tab = page.locator('nav.tabbar button.tab').first();
  await expect(tab).toBeVisible();

  const desc = await tab.getAttribute('aria-description');
  expect(desc, 'bound control must expose aria-description to AT').toBeTruthy();
  // Carries the flattened plain-English copy (title + "What it does: …").
  expect(desc!).toContain('What it does:');
  const label = (await tab.textContent() || '').trim();
  expect(desc!).toContain(label);

  // And the visual hovercard is (still) hidden from AT — the description is the AT path.
  await expect(page.locator('.hoverdetail')).toHaveAttribute('aria-hidden', 'true');
});
