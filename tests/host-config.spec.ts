import { test, expect } from './fixtures';
import { dataPayload, installFixtures } from './page-fixtures';

// Infra → Host Inventory: a host row opens the DNS or DHCP settings that host
// loaded (GET /api/host-config). The server hides secrets (Go tests prove
// that); the route here is mocked with the server's redacted shape, and this
// checks the viewer opens, switches, copies, copes with a grid member and a
// failure, and shows no secret.

const SECRET = 'test-only-not-a-real-tsig';
const OPHID = '96d9195bd3a4a56368520a0091a72623';

const HOSTS = [
  { id: 'infra/host/x1', name: 'nios-x-east', ip: '10.10.0.2', status: 'ok', type: 'DNS', ophid: OPHID, host_type: '3' },
  { id: 'infra/host/g1', name: 'grid-member-1', ip: '10.20.0.2', status: 'ok', type: 'Host', ophid: '4cddc25663851bf076b51609af0e5d2b', host_type: '6' },
];

const DNS = {
  status: 'ok', hidden: 1, platform: 'nios-x', version: 'v4.5', variant: 'default', retrieved_at: '2026-11-10T09:48:09Z',
  files: [{ name: 'named.conf', text: 'key "bind-key" {\n    algorithm hmac-sha256;\n    secret "(hidden)";\n};\n\noptions {\n    directory "/var/named";\n};\n' }],
};
const DHCP = {
  status: 'ok', hidden: 0, platform: 'nios-x', version: 'v4.5', variant: 'default', retrieved_at: '2026-11-10T09:48:09Z',
  files: [
    { name: 'kea-dhcp4.conf', text: '{\n    "Dhcp4": {\n        "authoritative": false\n    }\n}\n' },
    { name: 'kea-dhcp-ddns.conf', text: '{\n    "DhcpDdns": {}\n}\n' },
  ],
};

function json(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// The fixture catch-all goes in first: Playwright tries the newest route
// first, so each test's own /api/host-config route must be added after it.
test.beforeEach(async ({ page }) => {
  await installFixtures(page, 'infra');
});

async function openInfra(page: import('@playwright/test').Page, hosts = HOSTS) {
  await page.route('**/api/data*', (route) => json(route, { ...dataPayload(), hosts, _totals: { hosts: hosts.length } }));
  await page.goto('/#infra');
}

test('a host row opens its settings, DNS then DHCP, with no secret on screen', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/host-config*', (route) => {
    const u = new URL(route.request().url());
    asked.push(`${u.searchParams.get('ophid')} ${u.searchParams.get('type')}`);
    return json(route, u.searchParams.get('type') === 'dhcp' ? DHCP : DNS);
  });
  await openInfra(page);
  // A mouse clicks anywhere on the row.
  await page.getByRole('row', { name: /nios-x-east/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings on nios-x-east' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('secret "(hidden)";')).toBeVisible();
  await expect(dialog).not.toContainText(SECRET);
  await expect(dialog.getByRole('button', { name: 'DNS' })).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByRole('button', { name: 'DHCP' }).click();
  await expect(dialog.getByRole('region', { name: 'kea-dhcp4.conf' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'kea-dhcp-ddns.conf' })).toBeVisible();
  expect(asked).toEqual([`${OPHID} dns`, `${OPHID} dhcp`]);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('copy puts the shown settings on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/host-config*', (route) => json(route, DNS));
  await openInfra(page);
  await page.getByRole('button', { name: 'View details for nios-x-east' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings on nios-x-east' });
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByText('Copied.')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(DNS.files[0].text);
});

test('a NIOS grid member says it has no settings here, and asks nothing', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/host-config*', (route) => { calls++; return json(route, DNS); });
  await openInfra(page);
  await page.getByRole('button', { name: 'View details for grid-member-1' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings on grid-member-1' });
  await expect(dialog).toContainText('This is a NIOS grid member');
  await expect(dialog.getByRole('button', { name: 'DNS' })).toHaveCount(0);
  expect(calls).toBe(0);
});

test('a failed read says so and can try again; an empty one is not a failure', async ({ page }) => {
  let n = 0;
  await page.route('**/api/host-config*', (route) => {
    n++;
    return n === 1
      ? json(route, { status: 'error', files: [], reason: 'Could not reach Infoblox for this host\'s settings.' })
      : json(route, { status: 'empty', files: [] });
  });
  await openInfra(page);
  await page.getByRole('button', { name: 'View details for nios-x-east' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings on nios-x-east' });
  await expect(dialog).toContainText('DNS settings did not load');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog).toContainText('This host has no DNS settings saved.');
  await expect(dialog).not.toContainText('did not load');
});

test('rows without an OPH ID open nothing', async ({ page }) => {
  await openInfra(page, [{ id: 'infra/host/n', name: 'plain-host', ip: '10.0.0.9', status: 'ok', type: 'Host' }]);
  await expect(page.getByText('plain-host')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View details for plain-host' })).toHaveCount(0);
});

// Switching DNS → DHCP while the DNS body is still arriving aborts the DNS
// read. That abort must not show up as a failure over the DHCP read's loading
// state. The DNS answer's headers arrive (status 200) but its body read only
// ends when the abort rejects it, which is how a slow body behaves in a real
// browser; page.route cannot stream a body slowly, so fetch is wrapped.
test('switching while a read is in flight shows the new read, never a stale error', async ({ page }) => {
  await page.addInitScript(() => {
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const r = await realFetch(url, opts);
      if (!String(url).includes('/api/host-config') || !String(url).includes('type=dns')) return r;
      const sig = opts?.signal;
      return {
        ok: r.ok,
        status: r.status,
        json: () => new Promise((_, reject) => {
          const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (!sig || sig.aborted) fail(); else sig.addEventListener('abort', fail);
        }),
      } as Response;
    };
  });
  let releaseDhcp = () => {};
  const dhcpHeld = new Promise<void>((resolve) => { releaseDhcp = resolve; });
  await page.route('**/api/host-config*', async (route) => {
    const dhcp = new URL(route.request().url()).searchParams.get('type') === 'dhcp';
    if (dhcp) await dhcpHeld;
    return json(route, dhcp ? DHCP : DNS);
  });
  await openInfra(page);
  await page.getByRole('button', { name: 'View details for nios-x-east' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Settings on nios-x-east' });
  await expect(dialog.getByText('Loading…')).toBeVisible();

  await dialog.getByRole('button', { name: 'DHCP' }).click();
  // Give a stale error time to land if it is going to.
  await page.waitForTimeout(500);
  await expect(dialog.getByText('Loading…')).toBeVisible();
  await expect(dialog).not.toContainText('did not load');

  releaseDhcp();
  await expect(dialog.getByRole('region', { name: 'kea-dhcp4.conf' })).toBeVisible();
  await expect(dialog).not.toContainText('did not load');
});
