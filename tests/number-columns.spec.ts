import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// IN A RIGHT-ALIGNED COLUMN OF NUMBERS, THE DIGITS LINE UP.
//
// Inter's digits are proportional by default: a 1 is narrower than an 8, so in
// a right-aligned column the tens of "111" do not sit under the tens of "888".
// A column is right-aligned because it is read downwards, digit against digit,
// so each one draws its digits at a single width, by one of the two means the
// app already had:
//
//   - the mono face (`mono: true`), which Security's counts and DNS's TTL used
//     from the start, or
//   - `tabular-nums` on the span a `render` column returns, as Daily's Used and
//     Free did.
//
// WHY NOT ONE RULE ON EVERY CELL. DataTable sizes a plain column by measuring
// its text on a canvas, and a canvas cannot apply font-variant-numeric: the
// painted digits would be wider than the measured ones and the column would
// clip. tests/table-measures-what-it-paints.spec.ts exists for that class of
// defect. A `render` column is measured by laying its real cells out, so what
// is measured there is what is painted, whatever its classes say.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// The baseline world has no licences, and License Inventory holds two of the
// columns this is about.
const LICENSES = {
  status: 'ok',
  licenses: [
    { id: 'lic-1', name: 'Baseline DDI', sku: 'IB-BASE-1', state: 'active', expiry: '2027-07-12T00:00:00Z', quantity: 1118, evaluation: false },
    { id: 'lic-2', name: 'Baseline Threat Defense', sku: 'IB-BASE-2', state: 'active', expiry: '2029-10-24T00:00:00Z', quantity: 3000, evaluation: false },
  ],
};

// tab -> the right-aligned number columns it must be found drawing, by panel
// and heading. Named, so a column that stops rendering fails here instead of
// quietly dropping out of the check.
const EXPECTED: Record<string, Array<[string, string]>> = {
  overview: [['subnet-table', 'Free'], ['license-inventory', 'Time Left'], ['license-inventory', 'Qty']],
  network: [['network-exhaustion', 'Used'], ['network-exhaustion', 'Free']],
  dns: [['dns-zones', 'Records'], ['dns-dtc-lbdn', 'Precedence'], ['dns-dtc-lbdn', 'TTL']],
};

type Column = { panel: string; heading: string; cells: number; loose: string[] };

// Runs in the page: every right-aligned column of every table, with the cells
// in it that hold a digit and are drawn in neither a mono face nor tabular
// figures.
function readNumberColumns(): Column[] {
  const probe = document.createElement('span');
  probe.className = 'font-mono';
  document.body.appendChild(probe);
  const monoFamily = getComputedStyle(probe).fontFamily;
  probe.remove();

  const out: Column[] = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const panel = table.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? '(no panel)';
    const heads = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
    heads.forEach((th, i) => {
      if (getComputedStyle(th).textAlign !== 'right') return;
      // The heading without the sort arrow, in the case it is written in.
      const clone = th.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
      const heading = (clone.textContent || '').trim();
      const col: Column = { panel, heading, cells: 0, loose: [] };
      for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
        const td = tr.children[i] as HTMLElement | undefined;
        if (!td) continue;
        const text = (td.textContent || '').trim();
        if (!/\d/.test(text)) continue;
        col.cells++;
        // The element the text is actually painted in.
        const painted = (td.firstElementChild as HTMLElement) || td;
        const cs = getComputedStyle(painted);
        const fixed = cs.fontFamily === monoFamily || cs.fontVariantNumeric.includes('tabular-nums');
        if (!fixed) col.loose.push(text.slice(0, 24));
      }
      out.push(col);
    });
  }
  return out;
}

for (const [tab, expected] of Object.entries(EXPECTED)) {
  test(`#${tab}: every right-aligned column of numbers draws its digits at one width`, async ({ page }) => {
    await page.route('**/api/csp/license-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LICENSES) }),
    );
    await page.setViewportSize({ width: 1920, height: 2400 });
    await page.goto(`/#${tab}`);
    // Every table named above has rows before anything is read.
    for (const [panel] of expected) {
      await expect(page.locator(`[data-panel-id="${panel}"] tbody tr`).first()).toBeVisible({ timeout: 20_000 });
    }

    const columns = await page.evaluate(readNumberColumns);
    const found = (panel: string, heading: string) =>
      columns.find((c) => c.panel === panel && c.heading.toLowerCase() === heading.toLowerCase());

    for (const [panel, heading] of expected) {
      const col = found(panel, heading);
      expect(col, `${panel} has no right-aligned "${heading}" column`).toBeTruthy();
      expect(col!.cells, `${panel} "${heading}" drew no numbers to check`).toBeGreaterThan(0);
    }
    const loose = columns
      .filter((c) => c.loose.length > 0)
      .map((c) => `${c.panel} "${c.heading}": ${c.loose.slice(0, 3).join(', ')}`);
    expect(loose, `right-aligned number columns drawn with proportional digits:\n  ${loose.join('\n  ')}`).toEqual([]);
  });
}
