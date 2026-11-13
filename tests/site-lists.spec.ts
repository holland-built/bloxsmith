import { test, expect } from './fixtures';

// Site lists (owner, 2026-11-12): sites from the top sites, a CSV or pasted
// text go into a custom list, and the list into a policy with any action, at
// any place. Top sites compares InfoRank with this network's busiest sites,
// and a never-add list is left out (owner, 2026-11-13).

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const TARGETS = {
  ok: true,
  lists: [{ id: 5, name: 'vip', item_count: 3, policies: ['Office'] }],
  policies: [{ id: 7, name: 'Office', rules: [
    { type: 'named_feed', data: 'Base', action: 'action_block' },
    { type: 'custom_list', data: 'vip', action: 'action_allow' },
  ] }],
  redirects: ['company-page'],
};
const PLAN = {
  ok: true, dry_run: true, fingerprint: 'fp-1',
  list: { name: 'top-sites', new: true, will_add: 2, already_there: 0, also_used_by: [] },
  policy: { id: 7, name: 'Office', adds_rule: true, existing_rule: 0,
    after: [
      { type: 'named_feed', data: 'Base', action: 'action_block' },
      { type: 'custom_list', data: 'top-sites', action: 'action_allow' },
      { type: 'custom_list', data: 'vip', action: 'action_allow' },
    ] },
  sample: ['google.com', 'zoom.us'],
};

async function open(page: import('@playwright/test').Page, sent: Record<string, any>[], never: string[] = []) {
  await page.route('**/api/lists/targets', (r) => r.fulfill(json(TARGETS)));
  await page.route('**/api/lists/never-add', (r) => r.fulfill(json({ ok: true, sites: never })));
  await page.route('**/api/lists/apply', (r) => {
    const b = r.request().postDataJSON();
    sent.push(b);
    return b.dry
      ? r.fulfill(json(PLAN))
      : r.fulfill(json({ ...PLAN, dry_run: undefined, ok: true, outcome: 'verified', steps: { list: { added: 2 }, policy: { position: 2 } } }));
  });
  await page.goto('/#lists');
  await expect(page.getByRole('heading', { level: 1, name: 'Site lists' })).toBeVisible();
}

test('pasted sites go into a new list, placed where asked, with the action asked', async ({ page }) => {
  const sent: Record<string, any>[] = [];
  await open(page, sent);
  await page.getByRole('radio', { name: 'Paste them in' }).check();
  await page.getByRole('textbox', { name: 'One site per line, or separated by commas' }).fill('Google.com\nzoom.us, not-a-site');
  await expect(page.getByText('1 line is not a site and will be left out: not-a-site')).toBeVisible();
  await page.getByRole('textbox', { name: 'New list name' }).fill('top-sites');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('7');
  const action = page.getByRole('combobox', { name: 'What the policy does with these sites' });
  await expect(action.locator('option')).toHaveText(['Block', 'Allow', 'Log only', 'Redirect', 'Block without logging', 'Redirect without logging']);
  await action.selectOption('action_allow');
  await page.getByRole('combobox', { name: /Where the rule goes/ }).selectOption({ label: 'After rule 1: Base (named feed), Block' });

  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('This will make a new list, top-sites, with 2 sites. Office will use it as Allow, rule 2 of 3.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'top-sites, Allow (new)' })).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ dry: true, domains: ['google.com', 'zoom.us'], list: { name: 'top-sites' }, policy_id: 7, action: 'action_allow', position: 1 });

  await page.getByRole('button', { name: 'Add to policy' }).click();
  await expect(page.getByText('Done. top-sites gained 2 sites, and Office now uses it (rule 2).')).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ dry: false, fingerprint: 'fp-1' });
});

test('the top sites compare InfoRank with this network, and the owner picks which go in', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/lists/inforank*', (r) => {
    asked.push(r.request().url());
    return r.fulfill(json({ ok: true, date: '2026-11-12T17:34:56Z', total: 50000, domains: ['gstatic.com', 'apple.com', 'akamai.net'] }));
  });
  await page.route('**/api/lists/busiest*', (r) => {
    asked.push(r.request().url());
    return r.fulfill(json({ ok: true, domains: ['apple.com', 'netflix.com', 'gstatic.com'], queries: [9, 8, 7], total: 40, names: 300, estimate: false, days: 7 }));
  });
  const sent: Record<string, any>[] = [];
  await open(page, sent);
  await page.getByRole('spinbutton', { name: 'How many, from the top' }).fill('3');
  await page.getByRole('button', { name: 'Get both lists' }).click();
  const cmp = page.locator('[data-top-compare]');
  await expect(cmp).toContainText('InfoRank: the 3 most popular sites on the internet, list of 2026-11-12.');
  await expect(cmp).toContainText('Your network: the 3 sites looked up most in the last 7 days.');
  await expect(cmp.getByText('On both lists: 2')).toBeVisible();
  await expect(cmp.getByText('Only on InfoRank: 1')).toBeVisible();
  await expect(cmp.getByText('Only on your network: 1')).toBeVisible();
  expect(asked.some((u) => u.includes('inforank?top=3'))).toBe(true);
  expect(asked.some((u) => u.includes('busiest?top=3'))).toBe(true);

  await page.getByRole('combobox', { name: 'Which of the top 3 go in' }).selectOption('both');
  await page.getByRole('textbox', { name: 'New list name' }).fill('top-sites');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].domains).toEqual(['gstatic.com', 'apple.com']);
});

test('when one list cannot be read, the other still works', async ({ page }) => {
  await page.route('**/api/lists/inforank*', (r) => r.fulfill(json({ ok: false, error: 'InfoRank list: http 403' }, 502)));
  await page.route('**/api/lists/busiest*', (r) => r.fulfill(json({ ok: true, domains: ['apple.com'], queries: [9], total: 1, names: 10000, estimate: true, days: 7 })));
  await open(page, []);
  await page.getByRole('button', { name: 'Get both lists' }).click();
  const cmp = page.locator('[data-top-compare]');
  await expect(cmp).toContainText('Could not get the InfoRank list: InfoRank list: http 403');
  await expect(cmp).toContainText('an estimate because Infoblox sent only the 10,000 busiest names');
  await expect(page.getByRole('combobox', { name: /Which of the top/ }).locator('option')).toHaveText(["Your network's busiest sites"]);
  await expect(page.getByText('1 site ready.')).toBeVisible();
});

test('sites on the never-add list are left out, and saving it sends the cleaned list', async ({ page }) => {
  const sent: Record<string, any>[] = [];
  await open(page, sent, ['google.com']);
  let saved: any = null;
  await page.route('**/api/lists/never-add', (r) => {
    if (r.request().method() !== 'POST') return r.fulfill(json({ ok: true, sites: ['google.com'] }));
    saved = r.request().postDataJSON();
    return r.fulfill(json({ ok: true, sites: saved.sites }));
  });
  await page.reload();
  await page.getByRole('radio', { name: 'Paste them in' }).check();
  await page.getByRole('textbox', { name: 'One site per line, or separated by commas' }).fill('www.google.com zoom.us');
  await expect(page.getByText('1 site on the never-add list will be left out: www.google.com')).toBeVisible();
  await expect(page.getByText('1 site ready.')).toBeVisible();
  await page.getByRole('textbox', { name: 'New list name' }).fill('top-sites');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].domains).toEqual(['www.google.com', 'zoom.us']);

  const box = page.getByRole('textbox', { name: /Sites never to add/ });
  await expect(box).toHaveValue('google.com');
  await box.fill('Google.com\nexample.org');
  await page.getByRole('button', { name: 'Save never-add list' }).click();
  await expect(page.getByText('Saved: 2 sites never to add.')).toBeVisible();
  expect(saved).toEqual({ sites: ['google.com', 'example.org'] });
});

test('a CSV file is read from its first column', async ({ page }) => {
  await open(page, []);
  await page.getByRole('radio', { name: 'A CSV file' }).check();
  await page.getByLabel('CSV file: one site per row, in the first column').setInputFiles({
    name: 'sites.csv', mimeType: 'text/csv', buffer: Buffer.from('domain,rank\nexample.com,1\nexample.org,2\nbad row,3\n'),
  });
  await expect(page.getByText('2 sites from sites.csv.')).toBeVisible();
  await expect(page.getByText('1 line is not a site and will be left out: bad row')).toBeVisible();
});

test('Redirect asks which block page', async ({ page }) => {
  await open(page, []);
  await expect(page.getByRole('combobox', { name: 'Block page' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'What the policy does with these sites' }).selectOption('action_redirect');
  await expect(page.getByRole('combobox', { name: 'Block page' }).locator('option')).toHaveText(['Infoblox block page', 'company-page']);
});

test('the preview warns when other policies use the list', async ({ page }) => {
  await page.route('**/api/lists/targets', (r) => r.fulfill(json(TARGETS)));
  await page.route('**/api/lists/never-add', (r) => r.fulfill(json({ ok: true, sites: [] })));
  await page.route('**/api/lists/apply', (r) => r.fulfill(json({ ...PLAN,
    list: { name: 'vip', new: false, will_add: 1, already_there: 1, also_used_by: ['Lab'] },
    policy: { ...PLAN.policy, adds_rule: false, existing_rule: 2, after: TARGETS.policies[0].rules } })));
  await page.goto('/#lists');
  await page.getByRole('radio', { name: 'Paste them in' }).check();
  await page.getByRole('textbox', { name: 'One site per line, or separated by commas' }).fill('a.com b.com');
  await page.getByRole('radio', { name: 'Add to a list I have' }).check();
  await page.getByRole('combobox', { name: 'List', exact: true }).selectOption('5');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('This will add 1 site to vip (1 site already there is left as it is). Office already uses it (rule 2), so the policy does not change.')).toBeVisible();
  await expect(page.getByText('vip is also used by Lab. The new sites take effect there too.')).toBeVisible();
});

test('a site on a threat list is shown, left out, and goes in only when ticked and previewed again', async ({ page }) => {
  const sent: Record<string, any>[] = [];
  await page.route('**/api/lists/targets', (r) => r.fulfill(json(TARGETS)));
  await page.route('**/api/lists/never-add', (r) => r.fulfill(json({ ok: true, sites: [] })));
  await page.route('**/api/lists/apply', (r) => {
    const b = r.request().postDataJSON();
    sent.push(b);
    const ok = (b.risky_ok ?? []).includes('bad.example');
    return r.fulfill(json({ ...PLAN, fingerprint: ok ? 'fp-2' : 'fp-1',
      list: { ...PLAN.list, will_add: ok ? 2 : 1 },
      threats: { checked: 2, risky: [{ domain: 'bad.example', class: 'MalwareC2', level: 100, added: ok }], unchecked: 1, reason: 'Infoblox did not answer the threat lookup (http 503)', left_out: ok ? 1 : 2 } }));
  });
  await page.goto('/#lists');
  await page.getByRole('radio', { name: 'Paste them in' }).check();
  await page.getByRole('textbox', { name: 'One site per line, or separated by commas' }).fill('zoom.us bad.example other.example');
  await page.getByRole('textbox', { name: 'New list name' }).fill('top-sites');
  await page.getByRole('combobox', { name: 'Policy', exact: true }).selectOption('7');
  await page.getByRole('button', { name: 'Preview' }).click();

  const threats = page.getByRole('group', { name: 'Threat check' });
  await expect(threats).toContainText("1 site is on Infoblox's threat lists, so it is left out unless you tick it:");
  await expect(threats).toContainText('bad.example: MalwareC2, threat level 100. Add anyway');
  await expect(threats).toContainText('1 site could not be checked (Infoblox did not answer the threat lookup (http 503)), so it is left out.');
  expect(sent[0]).toMatchObject({ risky_ok: [], unchecked_ok: false });

  await threats.getByRole('checkbox', { name: /bad\.example/ }).check();
  await expect(page.getByRole('button', { name: 'Add to policy' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ dry: true, risky_ok: ['bad.example'] });
  await page.getByRole('button', { name: 'Add to policy' }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ dry: false, risky_ok: ['bad.example'], fingerprint: 'fp-2' });
});
