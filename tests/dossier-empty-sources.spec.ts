import { test, expect } from './fixtures';

// AI → Threat lookup → Dossier panel.
//
// DossierPanel's guard was `data.summary && typeof data.summary === 'object'
// && Array.isArray(data.sources)`. An EMPTY array is an array, so a dossier
// body whose every source came back unusable — summary present but zeroed,
// sources: [], unavailable: null — sailed through it, `mal` read false, and
// the panel painted a green CLEAN pill for an indicator against which nothing
// had been checked. On a security tool that is the worst failure direction:
// the analyst is told "safe" when the honest answer is "we did not look".
//
// The server half (threatintel.go normDossier) no longer emits that body. The
// bodies below are stubbed at the route precisely so the PANEL half is what's
// under test: even handed the pre-fix shape, it must refuse to render a
// verdict. The `CLEAN` absence assertion is the one with teeth.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const EMPTY_SUMMARY = {
  malicious: false, max_threat_level: 0, threat_classes: [], properties: [],
  country: '', registrar: '', actor: '',
};

// The pre-fix server shape: a verdict-looking body with zero examined sources.
const NO_SOURCES_EXAMINED = {
  query: 'nothing-checked.example.com', type: 'host',
  summary: EMPTY_SUMMARY, sources: [], unavailable: null,
};

// What the fixed server now sends for the same lookup: the dossierUnavail
// shape, with a reason that says the lookup RAN and answered with nothing —
// distinct from "the fetch failed".
const SERVER_DEGRADED = {
  query: 'nothing-checked.example.com', type: 'host',
  summary: {}, sources: [], unavailable: 'Dossier lookup returned no usable sources',
};

// The control: one source genuinely examined, nothing malicious found. This
// is what "clean" actually looks like, and it must still say CLEAN.
const ONE_SOURCE_EXAMINED = {
  query: 'benign.example.com', type: 'host',
  summary: { ...EMPTY_SUMMARY, country: 'United States' },
  sources: [{ source: 'geo', geo: { country: 'US', country_name: 'United States' } }],
  unavailable: null,
};

const THREAT_LOOKUP_OK = { entities: [], query: 'benign.example.com', availability: 'ok' };

async function lookup(page: import('@playwright/test').Page, dossierBody: unknown, query: string) {
  await page.route('**/api/dossier*', (route) => fulfillJson(route, dossierBody));
  await page.route('**/api/threat-lookup*', (route) => fulfillJson(route, THREAT_LOOKUP_OK));
  await page.goto('/#ai');
  const card = page.locator('text=Threat lookup').locator('..').locator('..');
  await card.getByPlaceholder('domain, IP, or host…').fill(query);
  await card.getByRole('button', { name: 'Lookup', exact: true }).click();
  return card;
}

test.describe('AI → Dossier panel (a lookup that examined no source)', () => {
  test('sources:[] with a zeroed summary never renders CLEAN', async ({ page }) => {
    const card = await lookup(page, NO_SOURCES_EXAMINED, 'nothing-checked.example.com');
    // The assertion with teeth, asserted FIRST so it is the one that speaks
    // when the guard regresses: no verdict pill of any kind.
    await expect(card.getByText(/\bCLEAN\b/)).toHaveCount(0);
    await expect(card.getByText(/\bMALICIOUS\b/)).toHaveCount(0);
    await expect(card.getByText(/dossier unavailable/i)).toBeVisible();
    await expect(card.getByText(/nothing was checked/i)).toBeVisible();
  });

  test('the server-degraded body renders its own reason, not a verdict', async ({ page }) => {
    const card = await lookup(page, SERVER_DEGRADED, 'nothing-checked.example.com');
    await expect(card.getByText(/dossier unavailable/i)).toBeVisible();
    await expect(card.getByText(/no usable sources/i)).toBeVisible();
    // "ran and answered with nothing" must not read as "the fetch failed".
    await expect(card.getByText(/fetch failed/i)).toHaveCount(0);
    await expect(card.getByText(/\bCLEAN\b/)).toHaveCount(0);
  });

  test('one genuinely examined source still renders CLEAN', async ({ page }) => {
    const card = await lookup(page, ONE_SOURCE_EXAMINED, 'benign.example.com');
    await expect(card.getByText(/\bCLEAN\b/)).toBeVisible();
    await expect(card.getByText(/dossier unavailable/i)).toHaveCount(0);
  });
});
