import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// EVERY CONTROL SAYS WHAT IT IS, AND EVERY CLICKABLE ROW SAYS WHICH ROW.
//
// From the 2026-08-27 GUI audit. Lighthouse found three accessibility failures
// on the Overview tab; sweeping all fifteen tabs in a browser found the same
// three defects in nine more places, because Lighthouse audits the page you
// point it at and this app is fifteen pages behind one URL.
//
// What that sweep measured, before the fix:
//
//   6 selects with no accessible name   overview, network x2, infra, audit,
//                                       and one more the per-tab count caught
//   58 inputs with no accessible name   50 of them one checkbox per row in
//                                       Security's triage inbox, where a
//                                       screen reader announced "checkbox"
//                                       fifty times and named no threat
//   150 rows, ONE distinct label        Overview's subnet table, every row
//                                       announcing "View details for row"
//
// THE LAST ONE IS THE INTERESTING DEFECT, because the code was already trying
// to do the right thing. DataTable built `View details for ${r.name ?? r.id ??
// 'row'}`, which is correct for a table whose rows carry one of those keys and
// silently useless for one that does not. Daily's table produced 30 distinct
// labels from the same line on the same run. A subnet row keys its identity as
// `network`, so both branches missed and all 150 fell to the literal.
//
// A PLACEHOLDER IS NOT A NAME. Every unnamed input here had one. It disappears
// the moment the field has content, it is not consistently exposed as an
// accessible name, and a reader who tabs into a filled field hears nothing at
// all. That is why the fix adds aria-label rather than trusting the placeholder
// that was already sitting there looking like a label.

const TABS = [
  'overview', 'daily', 'network', 'dns', 'security', 'infra', 'incidents',
  'audit', 'assets', 'provision', 'selfservice', 'drift', 'changes', 'editor', 'ai',
];

// How long a tab is given to paint its controls.
const SETTLE_MS = 1400;

// The tabs that MUST render at least one select or input, and the floor for
// each. Aggregate totals are not enough on their own: they let one tab stay
// blank or half-loaded while another supplies the count, and the blank one is
// exactly where a defect would hide. Codex's finding 3 on this change.
//
// ONE, not a census. The first version of this table carried the numbers from
// the live tenant, where Security's triage inbox renders 50 checkboxes. The
// FIXTURE world renders 2, so the floor could never be met and the test was red
// against a fix that worked. That is the second time on this change that a
// number taken from the live app was wrong for the fixture, which is the lesson
// worth keeping: a floor has to come from the world the test runs in.
//
// What this still catches is the thing Codex named: a tab that renders NOTHING
// hiding behind another tab's total. It does not try to pin how much each tab
// carries, because that number is data-dependent and would be a maintenance tax
// with no defect behind it.
const MUST_RENDER_CONTROLS = ['overview', 'network', 'security', 'infra', 'incidents', 'audit', 'ai'];

type Finding = { tab: string; kind: string; detail: string };

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('every select and input on every tab has an accessible name', async ({ page }) => {
  const unnamed: Finding[] = [];
  let selectsSeen = 0;
  let inputsSeen = 0;
  const tabsWithControls: string[] = [];
  const perTab: Record<string, number> = {};

  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(SETTLE_MS);
    const res = await page.evaluate(() => {
      // The four routes to an accessible name that this app actually uses. An
      // implicit wrapper counts: the Field component in Provision and
      // SelfService renders a real <label> around its children, which is why
      // those two tabs were already clean and are not touched by the fix.
      const named = (el: Element) =>
        !!(
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.closest('label') ||
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
        );
      const describe = (el: Element) => {
        const e = el as HTMLInputElement;
        const panel = el.closest('[data-panel-id]')?.getAttribute('data-panel-id') || 'chrome';
        return `${el.tagName.toLowerCase()}${e.type ? `[type=${e.type}]` : ''} in ${panel}` +
          (e.placeholder ? ` (placeholder "${e.placeholder}")` : '');
      };
      const selects = Array.from(document.querySelectorAll('select'));
      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden])'));
      return {
        selects: selects.length,
        inputs: inputs.length,
        bad: [...selects, ...inputs].filter((e) => !named(e)).map(describe),
      };
    });
    selectsSeen += res.selects;
    inputsSeen += res.inputs;
    perTab[tab] = res.selects + res.inputs;
    if (res.selects + res.inputs > 0) tabsWithControls.push(tab);
    for (const d of res.bad) unnamed.push({ tab, kind: 'unnamed', detail: d });
  }

  // COUNTED PER TAB, so one blank tab cannot hide behind another's total.
  const thin = MUST_RENDER_CONTROLS
    .filter((tab) => (perTab[tab] ?? 0) < 1)
    .map((tab) => `${tab}: rendered ${perTab[tab] ?? 0} controls`);
  expect(
    thin,
    `Tabs that rendered fewer controls than they carry, so nothing on them was really checked:\n  ${thin.join('\n  ')}`,
  ).toEqual([]);
  expect(selectsSeen, 'no selects were found on any tab, so nothing was checked').toBeGreaterThan(5);
  expect(inputsSeen, 'no inputs were found on any tab, so nothing was checked').toBeGreaterThan(20);
  expect(
    tabsWithControls.length,
    `only ${tabsWithControls.length} tabs rendered any control: ${tabsWithControls.join(', ')}`,
  ).toBeGreaterThan(6);

  expect(
    unnamed.map((u) => `${u.tab}: ${u.detail}`),
    'Controls a screen reader cannot name. A placeholder is not an accessible name:\n  ' +
      unnamed.map((u) => `${u.tab}: ${u.detail}`).join('\n  '),
  ).toEqual([]);
});

test('a clickable table row is announced by its own first column', async ({ page }) => {
  const bad: string[] = [];
  let rowsSeen = 0;
  let tablesSeen = 0;

  for (const tab of TABS) {
    await page.goto(`/#${tab}`);
    await page.waitForTimeout(SETTLE_MS);
    const res = await page.evaluate(() => {
      const out: { panel: string; rows: number; distinct: number; sample: string; mismatched: { label: string; cells: string }[] }[] = [];
      document.querySelectorAll('table').forEach((table, i) => {
        const panel = table.closest('[data-panel-id]')?.getAttribute('data-panel-id') || `table-${i}`;
        const rows = Array.from(table.querySelectorAll('tbody tr[role="button"]'));
        if (rows.length === 0) return;
        const labels = rows.map((r) => r.getAttribute('aria-label') || '');
        // Does the label quote a value the row paints? Checked against every
        // cell rather than the first, because which column carries the identity
        // differs per table and a leading checkbox or action column carries
        // none.
        const mismatched = rows
          .map((r) => {
            const label = r.getAttribute('aria-label') || '';
            const cells = Array.from(r.children)
              .map((c) => (c.textContent || '').trim())
              .filter((v) => v && v !== '\u2014' && v !== '\u2013');
            const hit = cells.some((v) => label.includes(v));
            return hit ? null : { label, cells: cells.slice(0, 4).join(' | ') };
          })
          .filter(Boolean) as { label: string; cells: string }[];
        out.push({
          panel,
          rows: rows.length,
          distinct: new Set(labels).size,
          sample: labels[0] || '(none)',
          mismatched: mismatched.slice(0, 3),
        });
      });
      return out;
    });
    for (const t of res) {
      tablesSeen++;
      rowsSeen += t.rows;
      // A row's label must identify THAT row. One label shared by many rows is
      // the defect: it is what 150 subnet rows did, and the reader learns
      // nothing from any of them.
      if (t.rows > 1 && t.distinct === 1) {
        bad.push(`${tab}/${t.panel}: ${t.rows} rows share one label "${t.sample}"`);
      }
      // And it must not be the bare fallback, which is what a row whose keys
      // the labeller does not recognise falls to.
      if (/for row$/.test(t.sample)) {
        bad.push(`${tab}/${t.panel}: label is the generic fallback "${t.sample}"`);
      }
      // DISTINCT IS NOT ENOUGH, and this is the assertion that makes the test
      // about the fix rather than about uniqueness. 150 labels reading "row 1"
      // to "row 150" would be distinct, non-generic, and useless. The label has
      // to contain something the row actually SHOWS, so a reader hears the same
      // identity they can see. Codex's finding 6 on this change.
      for (const m of t.mismatched) {
        bad.push(`${tab}/${t.panel}: label "${m.label}" names nothing in the row (cells: ${m.cells})`);
      }
    }
  }

  expect(tablesSeen, 'no clickable tables were found, so nothing was checked').toBeGreaterThan(0);
  // 5, not 50. The first version of this line said 50, taken from the live
  // tenant where Overview alone renders 150 clickable rows. The FIXTURE world
  // renders 11 across every tab, so that floor could never be met and the test
  // was red against a fix that was working. The floor has to come from the
  // inventory the test actually runs against, and it is here to catch a page
  // that rendered nothing rather than to assert a row count.
  expect(rowsSeen, 'no clickable rows were found, so nothing was checked').toBeGreaterThan(5);
  expect(bad, `Clickable rows that do not identify themselves:\n  ${bad.join('\n  ')}`).toEqual([]);
});

test('accent text clears AA in both themes, on every tab that paints it', async ({ page }) => {
  // The accent is two tokens on purpose: --color-accent for fills, borders and
  // rings, --color-link for text. The fill passes at its own job (white on
  // accent is 4.55) and fails as text (4.47 at best, 3.97 on a field), so one
  // value cannot serve both. This asserts the text one, resolved in a browser
  // and measured against the background it actually lands on.
  //
  // BOTH THEMES AND SEVERAL TABS, because the two themes carry DIFFERENT values
  // (#1a80ff dark, #0063d8 light) and no single colour clears 4.5 against both
  // a near black and a near white. The first version of this test visited
  // Overview in the default theme only, so reverting the light token alone
  // would have passed it. Codex's finding 4 on this change.
  const MEASURED: string[] = [];
  const failures: string[] = [];

  for (const theme of ['dark', 'light'] as const) {
    for (const tab of ['overview', 'network', 'incidents', 'audit']) {
      // Set, then reload. addInitScript was the first approach and it is wrong
      // in a loop: each call ADDS another script rather than replacing the last,
      // so by the second theme the page runs both and the winner is whichever
      // the app happens to read first. Observed: data-theme stayed "dark" for
      // every light pass. Writing localStorage on the live page and reloading
      // has one writer and no ordering to reason about.
      await page.goto(`/#${tab}`);
      await page.evaluate((t) => localStorage.setItem('theme', t), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.waitForTimeout(SETTLE_MS);

      const res = await page.evaluate(() => {
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const parse = (s: string) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        const bgOf = (el: Element): number[] => {
          let e: Element | null = el;
          while (e && e !== document.documentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && !/,\s*0\)$/.test(c) && c !== 'transparent') return parse(c);
            e = e.parentElement;
          }
          return parse(getComputedStyle(document.body).backgroundColor);
        };
        const ratio = (fg: number[], bg: number[]) => {
          const a = lum(fg), b = lum(bg);
          const [hi, lo] = a > b ? [a, b] : [b, a];
          return (hi + 0.05) / (lo + 0.05);
        };
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-link)';
        document.body.appendChild(probe);
        const linkRgb = parse(getComputedStyle(probe).color).join(',');
        probe.remove();

        const painted = Array.from(document.querySelectorAll('*')).filter((e) => {
          if (!e.textContent || e.children.length > 0) return false;
          const r = e.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          return parse(getComputedStyle(e).color).join(',') === linkRgb;
        });

        return {
          token: getComputedStyle(document.documentElement).getPropertyValue('--color-link').trim(),
          count: painted.length,
          bad: painted.map((e) => {
            const cs = getComputedStyle(e);
            const fg = parse(cs.color), bg = bgOf(e);
            const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
            const need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3.0 : 4.5;
            const r = ratio(fg, bg);
            return { text: (e.textContent || '').trim().slice(0, 24), size, ratio: +r.toFixed(2), need, pass: r >= need };
          }).filter((f) => !f.pass),
        };
      });

      expect(res.token, `--color-link is not declared in the ${theme} theme`).toMatch(/^#|^rgb/);
      if (res.count > 0) MEASURED.push(`${theme}/${tab}:${res.count}`);
      for (const f of res.bad) {
        failures.push(`${theme}/${tab} "${f.text}" ${f.size}px scores ${f.ratio}, needs ${f.need}`);
      }
    }
  }

  // Both themes must have been exercised on something, or half the assertion
  // never ran. This is what stops a pass over a token nobody paints.
  const themesSeen = new Set(MEASURED.map((m) => m.split('/')[0]));
  expect(
    [...themesSeen].sort(),
    `accent text was only found in ${[...themesSeen].join(', ') || 'no'} theme; measured: ${MEASURED.join(', ')}`,
  ).toEqual(['dark', 'light']);

  expect(failures, `Accent text below its AA threshold:\n  ${failures.join('\n  ')}`).toEqual([]);
});
