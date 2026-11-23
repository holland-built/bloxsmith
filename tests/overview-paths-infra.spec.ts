import { test, expect, type Page } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// Overview's "Items requiring attention": one click must reach the failing
// items, filtered and in view, with a way back to the whole list.
const down = (svc: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `${svc}_h${i}`, state: i ? 'stopped' : 'error', host: `${svc}-host-${i}`, ip: `10.9.0.${i + 1}` }));
const bucket = (name: string, up: number, total: number) => ({
  name, status: 'crit', statusLabel: 'critical', availability: 'ok',
  meta: `1 error · ${up}/${total} up`, not_running: down(name.toLowerCase(), total - up),
});
const HEALTH = [bucket('DNS', 25, 28), bucket('DHCP', 10, 18), bucket('Security', 3, 5)];
const health = (page: Page, body: unknown, status = 200) =>
  page.route('**/api/hub/health', (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));

async function expectInView(page: Page, list: ReturnType<Page['locator']>) {
  await expect(list).toBeInViewport();
  await expect(list).toBeFocused();
  await expect.poll(async () => {
    const box = await list.boundingBox();
    const head = await page.evaluate(() => {
      const h = document.querySelector('header');
      return h ? h.getBoundingClientRect().bottom : 0;
    });
    return !!box && box.y >= head - 1;
  }).toBe(true);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}

for (const width of [1440, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    for (const [svc, count] of [['DHCP', 8], ['DNS', 3], ['Security', 2]] as const) {
      test(`${svc}: View services lands on the ${count} that are down`, async ({ page }) => {
        await installBaselineWorld(page);
        await health(page, HEALTH);
        await page.goto('/#overview');
        await page.getByRole('link', { name: new RegExp(`^View services: ${svc} services`) }).first().click();

        await expect(page).toHaveURL(new RegExp(`#infra\\?service=${svc}&status=down$`));
        const list = page.locator(`[data-services-down="${svc}"]`);
        await expect(list.getByRole('heading')).toContainText(`Showing ${count} ${svc} services that are down`);
        await expect(list.getByText(`${svc.toLowerCase()}-host-0`).first()).toBeVisible();
        await expect(list.getByText('stopped').first()).toBeVisible();
        await expectInView(page, list);

        await page.reload();
        await expect(list.getByRole('heading')).toContainText(`Showing ${count}`);
        await list.getByRole('button', { name: 'Show all' }).click();
        await expect(list).toHaveCount(0);
        await page.goBack();
        await expect(list.getByRole('heading')).toContainText(`Showing ${count}`);
      });
    }

    test('Hosts not online lands filtered, in view, with Show all', async ({ page }) => {
      await installBaselineWorld(page);
      await page.goto('/#infra?status=offline');
      const panel = page.locator('[data-panel-id="infra-host-inventory"]');
      await expect(panel.locator('[data-host-filter-line]')).toContainText('Showing 1 host not online');
      await expect(panel.getByText('baseline-host-c').first()).toBeVisible();
      await expect(panel.getByText('baseline-host-a')).toHaveCount(0);
      await expectInView(page, panel);
      await panel.locator('[data-host-filter-line]').getByRole('button', { name: 'Show all' }).click();
      await expect(panel.getByText('baseline-host-a').first()).toBeVisible();
    });
  });
}

test.describe('the page never claims none are down without knowing', () => {
  test.beforeEach(async ({ page }) => { await installBaselineWorld(page); });

  test('failed read', async ({ page }) => {
    await health(page, { error: 'boom' }, 500);
    await page.goto('/#infra?service=DHCP&status=down');
    const list = page.locator('[data-services-down="DHCP"]');
    await expect(list.getByRole('heading')).toContainText('could not be loaded');
    await expect(list).not.toContainText('No DHCP services are down');
  });

  test('dead feed bucket', async ({ page }) => {
    await health(page, [{ name: 'DHCP', status: 'error', statusLabel: 'unavailable', meta: 'feed unavailable', availability: 'error' }]);
    await page.goto('/#infra?service=DHCP&status=down');
    await expect(page.locator('[data-services-down="DHCP"]').getByRole('heading')).toContainText('could not be loaded');
  });

  test('cut-off list says there may be more', async ({ page }) => {
    await health(page, [{ ...bucket('DHCP', 10, 18), availability: 'partial' }]);
    await page.goto('/#infra?service=DHCP&status=down');
    await expect(page.locator('[data-services-down="DHCP"]').getByRole('heading')).toContainText('there may be more');
  });

  test('complete read with none down says so', async ({ page }) => {
    await health(page, [{ ...bucket('DHCP', 18, 18), status: 'ok' }]);
    await page.goto('/#infra?service=DHCP&status=down');
    await expect(page.locator('[data-services-down="DHCP"]').getByRole('heading')).toContainText('No DHCP services are down');
  });

  test('hosts feed failure is not "no hosts"', async ({ page }) => {
    await page.route('**/api/data*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
    await page.goto('/#infra?status=offline');
    await expect(page.locator('[data-host-filter-line]')).toContainText('could not be loaded');
  });
});
