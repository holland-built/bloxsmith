import type { Page, Route } from '@playwright/test';

// Synthetic API responses for tests/page-baseline.spec.ts (tier 2 of
// plans/033-page-baselines.md).
//
// WHY THIS EXISTS. Tier-1 baselines were captured with no Infoblox tenant, so
// every data panel on the page held "feed unavailable"-class copy, and five
// tabs — changes, provision, selfservice, editor, drift — could not be recorded
// at all because their upstream calls die on `dial tcp: lookup csp.invalid: no
// such host` and the console errors that follow are real errors, not empty
// states. Faking every response turns that into a fixed, healthy page that
// looks the same on every machine and on CI, which is the only way those five
// get a baseline and the only way any of them proves more than page structure.
//
// EVERYTHING HERE IS INVENTED. Nothing was recorded from the real tenant. This
// repo is public, and a HAR or a copied payload of live Infoblox traffic would
// publish real hostnames, IP space and tenant identifiers. Response SHAPES were
// read from the running server (key names only, no values) and from the
// payloads the 20-odd existing mocking specs already use; every value below was
// written by hand to be obviously fake.
//
// THE ENDPOINT LIST IS MEASURED, NOT GUESSED. A temporary probe spec recorded
// every /api/ request each page issues on load (2026-08-12). Five calls are
// made by the app shell on every page — brand, data, update/check, vault/status,
// views — and each page adds at most two of its own. Reading the JSX would have
// missed /api/data, which every tab depends on and no tab names.
//
// The five */stream endpoints on Provision are deliberately absent: the probe
// shows they are never touched on load, only on submit. A page-load baseline
// does not reach them.

// The instant the browser clock is frozen to. Every timestamp below is derived
// from it, so a row is always the same number of minutes old and a rendered
// "3 hours ago" cannot drift between two captures.
export const FIXED_NOW = new Date('2026-01-01T12:00:00Z');

const HOUR = 60 * 60 * 1000;
const agoIso = (ms: number) => new Date(FIXED_NOW.getTime() - ms).toISOString();

type Handler = {
  method: string;
  path: string;
  body: unknown;
  status?: number;
  // Some shell endpoints are not requested by every page. Only handlers marked
  // required are asserted to have actually been hit.
  required?: boolean;
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// The app shell — requested by every page.
// ---------------------------------------------------------------------------

// The single payload every tab reads. `_meta` carries one status per feed and
// the UI renders a failed feed differently from an empty one — that difference
// is what tests/failure-not-absence*.spec.ts exists to protect. Every feed is
// `ok` here, which is the whole point: it is the state no credential-free run
// can produce, and the state in which a lost panel is actually visible.
//
// The arrays are EMPTY, and that is a real limit of this fixture rather than an
// oversight. `ok` + empty renders each panel's healthy no-rows state: headings,
// column headers, filters and controls all present and correct. It does NOT
// exercise row rendering, so a regression that only breaks populated rows still
// gets past this. Filling them needs the row shape of eight separate feeds,
// each of which is its own measurement job. Recorded in
// plans/033-page-baselines.md as the next increment.
const DATA_FEEDS = ['subnets', 'leases', 'hosts', 'zones', 'dnsViews', 'secPolicies', 'feeds', 'auditLogs'];
const dataPayload = () => ({
  ...Object.fromEntries(DATA_FEEDS.map((k) => [k, []])),
  _totals: {},
  _meta: Object.fromEntries(DATA_FEEDS.map((k) => [k, 'ok'])),
});

const SHELL: Handler[] = [
  // Returns {} on a real server with no brand configured — the default, and the
  // state a new customer is in.
  { method: 'GET', path: '/api/brand', body: {}, required: true },
  { method: 'GET', path: '/api/data', body: dataPayload(), required: true },
  // Pinned to "no update available". A live check would put a version banner in
  // the header, and the answer would change every time a release is cut, which
  // is a baseline that rots on its own.
  {
    method: 'GET',
    path: '/api/update/check',
    body: { available: false, current: 'v0.0.0-baseline', latest: 'v0.0.0-baseline', checkDisabled: false, selfUpdate: false, url: '' },
    required: true,
  },
  {
    method: 'GET',
    path: '/api/vault/status',
    body: {
      active: 'baseline-tenant',
      exists: true,
      ready: true,
      unlocked: true,
      vaultMode: false,
      hasGroq: false,
      llm: { base_url: '', hasKey: false, model: '' },
      tenants: [{ id: 'baseline-tenant', label: 'Baseline Tenant' }],
      update: { available: false, checkDisabled: false, current: 'v0.0.0-baseline', latest: 'v0.0.0-baseline', selfUpdate: false, url: '' },
      version: 'v0.0.0-baseline',
      writeAllowed: [],
    },
    required: true,
  },
  // No saved layouts. A saved view reorders panels, so an empty list is the
  // only arrangement that means "the order the code ships with".
  { method: 'GET', path: '/api/views', body: { views: [] }, required: true },
];

// ---------------------------------------------------------------------------
// Per-page additions.
// ---------------------------------------------------------------------------

// Shape measured from the live server on 2026-08-06 and already relied on by
// tests/changes.spec.ts: action, id, resource, result, ts, user, who_kind,
// who_role. `ts` is the timestamp field — `created_at` is the upstream ordering
// param and is not on the row.
const auditRow = (over: Record<string, string>) => ({
  action: 'UPDATE',
  resource: 'addressservice',
  result: 'success',
  user: 'service.baseline',
  who_kind: 'service',
  who_role: 'ib-baseline-admin',
  ...over,
});

// Six hours of span with three actors, one delete and one failure, all fixed
// against FIXED_NOW so the 24-hour window, the grouping and the midpoint split
// land in the same place on every run.
const CSP_AUDIT = {
  status: 'ok',
  truncated: false,
  count: 5,
  rows: [
    auditRow({ id: 'b1', ts: agoIso(6 * HOUR), user: 'actor-alpha', resource: 'auth_zone' }),
    auditRow({ id: 'b2', ts: agoIso(5 * HOUR), user: 'actor-beta', resource: 'addressservice' }),
    auditRow({ id: 'b3', ts: agoIso(4 * HOUR), user: 'actor-alpha', action: 'DELETE', resource: 'dnsrecord' }),
    auditRow({ id: 'b4', ts: agoIso(2 * HOUR), user: 'actor-beta', resource: 'subnetservice' }),
    auditRow({ id: 'b5', ts: agoIso(1 * HOUR), user: 'actor-gamma', result: 'failed: denied', resource: 'addressservice' }),
  ],
};

const SPACES = { spaces: [{ id: 'ipam/ip_space/baseline-1', name: 'Baseline Space' }] };
const ZONES = { zones: [{ id: 'dns/auth_zone/baseline-1', fqdn: 'baseline.example.', name: 'baseline.example.' }] };

// Shape from the live server: a bare array of template objects.
const TEMPLATES = [
  { name: 'baseline-subnet', type: 'subnet', site: 'baseline-site', region: 'baseline-region', environment: 'test', valid: true },
];

const WHOAMI = { actor: 'baseline-operator', role: 'admin', tenant: 'baseline-tenant', token_auth: false };

const DNS_QPS = {
  status: 'ok',
  count: 3,
  rows: [
    { hour: agoIso(3 * HOUR), avg_value: 100.0 },
    { hour: agoIso(2 * HOUR), avg_value: 150.0 },
    { hour: agoIso(1 * HOUR), avg_value: 125.0 },
  ],
};

const LICENSE_ALERTS = { status: 'ok', licenses: [] };

const PER_PAGE: Record<string, Handler[]> = {
  changes: [{ method: 'GET', path: '/api/csp-audit', body: CSP_AUDIT, required: true }],
  drift: [
    { method: 'GET', path: '/api/ipam/spaces', body: SPACES, required: true },
    { method: 'GET', path: '/api/templates', body: TEMPLATES, required: true },
  ],
  selfservice: [
    { method: 'GET', path: '/api/ipam/spaces', body: SPACES, required: true },
    { method: 'GET', path: '/api/dns/zones', body: ZONES, required: true },
  ],
  provision: [
    { method: 'GET', path: '/api/ipam/spaces', body: SPACES, required: true },
    { method: 'GET', path: '/api/whoami', body: WHOAMI, required: true },
    { method: 'GET', path: '/api/templates', body: TEMPLATES },
  ],
  editor: [],
  overview: [
    { method: 'GET', path: '/api/csp/dns-qps', body: DNS_QPS, required: true },
    { method: 'GET', path: '/api/csp/license-alerts', body: LICENSE_ALERTS, required: true },
  ],
};

export const HAS_FIXTURES = Object.keys(PER_PAGE);

export type FixtureSession = {
  /** Requests to /api/ that no handler claimed. Must be empty. */
  unmatched: () => string[];
  /** Handlers marked required that were never hit. Must be empty. */
  neverCalled: () => string[];
};

/**
 * Serve every /api/ request for `pageId` from the fixtures above.
 *
 * Dispatch is by METHOD + exact PATHNAME. A catch-all that answered anything
 * plausible would hide the bug this is meant to catch: a request to a misspelled
 * path, or with the wrong verb, would get a valid-looking body and the page
 * would render as though nothing were wrong. Unmatched requests are ABORTED and
 * recorded, and the caller asserts the record is empty.
 *
 * The reverse check matters just as much. If a page stops calling an endpoint —
 * because a panel was deleted — the snapshot might still look plausible, so
 * every required handler must also actually be hit.
 */
export async function installFixtures(page: Page, pageId: string): Promise<FixtureSession> {
  const handlers = [...SHELL, ...(PER_PAGE[pageId] ?? [])];
  const unmatched: string[] = [];
  const hit = new Set<string>();

  await page.route('**/api/**', (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    const key = `${req.method()} ${pathname}`;
    const h = handlers.find((x) => x.method === req.method() && x.path === pathname);
    if (!h) {
      unmatched.push(key);
      return route.abort('failed');
    }
    hit.add(`${h.method} ${h.path}`);
    return json(route, h.body, h.status ?? 200);
  });

  return {
    unmatched: () => [...new Set(unmatched)].sort(),
    neverCalled: () =>
      handlers.filter((h) => h.required && !hit.has(`${h.method} ${h.path}`)).map((h) => `${h.method} ${h.path}`),
  };
}
