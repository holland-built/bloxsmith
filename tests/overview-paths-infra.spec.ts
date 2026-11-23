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

test('each attention row on Overview goes to its own address in one click', async ({ page }) => {
  await installBaselineWorld(page);
  await health(page, HEALTH);
  const incident = (category: string, message: string, severity: string) => ({ key: category, category, count: 5, severity, message });
  await page.route('**/api/incidents', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({
    incidents: [
      incident('subnet-utilization', '5 subnet utilization', 'crit'),
      incident('dns-ttl-anomaly', '5 dns ttl anomaly', 'warn'),
      incident('dnssec-unsigned', '5 dnssec unsigned', 'info'),
    ],
    signals: [],
  }) }));
  const rows: [RegExp, string][] = [
    [/^View services: DHCP services/, '#infra?service=DHCP&status=down'],
    [/^View services: DNS services/, '#infra?service=DNS&status=down'],
    [/^View services: Security services/, '#infra?service=Security&status=down'],
    [/^View hosts: /, '#infra?status=offline'],
    [/^View subnets: /, '#network?minUtil=70&links=1'],
    [/^View events: /, '#security?severity=high'],
    [/^View DNS: 5 zones have DNS timing/, '#dns?issues=1'],
    [/^View DNS: 5 DNS zones not signed/, '#dns?issues=dnssec'],
  ];
  for (const [name, address] of rows) {
    await page.goto('/#overview');
    await page.getByRole('region', { name: /Items requiring attention/ }).getByRole('link', { name }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(address);
  }
});

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

  for (const [what, b] of [
    ['a group with no rows before the cut-off', { name: 'DHCP', status: 'unknown', statusLabel: 'not listed', meta: 'beyond the row cap', availability: 'partial', reason: 'cut off' }],
    ['a group whose rows were all up before the cut-off', { ...bucket('DHCP', 18, 18), status: 'ok', availability: 'partial' }],
  ] as const) {
    test(`cut-off list with ${what} is not called clear`, async ({ page }) => {
      await health(page, [b]);
      await page.goto('/#infra?service=DHCP&status=down');
      const heading = page.locator('[data-services-down="DHCP"]').getByRole('heading');
      await expect(heading).toContainText('could not be fully checked');
      await expect(heading).not.toContainText('No DHCP services are down');
    });
  }

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

for (const width of [1440, 390]) {
  test.describe(`hosts landing with Host Inventory hidden, at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test('shows the hosts for this visit and leaves the saved layout alone', async ({ page }) => {
      await installBaselineWorld(page);
      const name = '__layout_infra';
      const saved = { name, order: ['infra-host-status', 'infra-service-health'], layout: { version: 1, spans: {}, hidden: ['infra-host-inventory'] } };
      const writes: string[] = [];
      await page.route('**/api/views', (r) => {
        if (r.request().method() !== 'GET') { writes.push(r.request().method()); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ views: [{ name }] }) });
      });
      await page.route(`**/api/views/${name}`, (r) => {
        if (r.request().method() !== 'GET') { writes.push(r.request().method()); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
        return r.fulfill({ contentType: 'application/json', body: JSON.stringify(saved) });
      });

      await page.goto('/#infra?status=offline');
      const list = page.locator('[data-hosts-landing]');
      await expect(list.locator('[data-host-filter-line]')).toContainText('Showing 1 host not online');
      await expect(list.getByText('baseline-host-c').first()).toBeVisible();
      await expect(list.getByText('baseline-host-a')).toHaveCount(0);
      await expectInView(page, list);
      await expect(page.locator('[data-panel-id="infra-host-inventory"]')).toHaveCount(0);
      // The Arrange panels list keeps the panel's real name during the visit.
      await page.getByTestId('hidden-tiles').getByRole('button', { name: 'Arrange panels' }).click();
      await expect(page.getByRole('button', { name: 'Put back on the page: Host Inventory' })).toBeVisible();
      await page.keyboard.press('Escape');

      await list.locator('[data-host-filter-line]').getByRole('button', { name: 'Show all' }).click();
      await expect(list).toHaveCount(0);
      await expect(page.locator('[data-panel-id="infra-host-inventory"]')).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  });
}
