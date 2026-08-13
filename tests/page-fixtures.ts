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
// Audit rows, defined here rather than next to the Changes fixture because
// /api/data's `auditLogs` feed carries the same shape and the shell payload
// below needs them. Shape measured from the live server on 2026-08-06 and
// already relied on by tests/changes.spec.ts: action, id, resource, result, ts,
// user, who_kind, who_role. `ts` is the timestamp — `created_at` is the upstream
// ordering param and is not on the row.
// ---------------------------------------------------------------------------
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
const CSP_AUDIT_ROWS = [
  auditRow({ id: 'b1', ts: agoIso(6 * HOUR), user: 'actor-alpha', resource: 'auth_zone' }),
  auditRow({ id: 'b2', ts: agoIso(5 * HOUR), user: 'actor-beta', resource: 'addressservice' }),
  auditRow({ id: 'b3', ts: agoIso(4 * HOUR), user: 'actor-alpha', action: 'DELETE', resource: 'dnsrecord' }),
  auditRow({ id: 'b4', ts: agoIso(2 * HOUR), user: 'actor-beta', resource: 'subnetservice' }),
  auditRow({ id: 'b5', ts: agoIso(1 * HOUR), user: 'actor-gamma', result: 'failed: denied', resource: 'addressservice' }),
];

// ---------------------------------------------------------------------------
// The app shell — requested by every page.
// ---------------------------------------------------------------------------

// The single payload every tab reads. `_meta` carries one status per feed and
// the UI renders a failed feed differently from an empty one — that difference
// is what tests/failure-not-absence*.spec.ts exists to protect. Every feed is
// `ok` here, which is the whole point: it is the state no credential-free run
// can produce, and the state in which a lost panel is actually visible.
//
// The arrays used to be EMPTY, which rendered each panel's healthy no-rows state
// and left row rendering unproven everywhere. Each feed now carries a small
// number of rows in the shape the live server returns (read as key names only on
// 2026-08-13), so a regression in how a row renders fails instead of passing.
//
// Row counts are deliberately tiny — two or three each. These feed tables, maps
// and charts across a dozen panels, and a baseline is read by a human in a diff:
// 500 synthetic subnets would make every one of those YAML files unreadable and
// nobody would review them. Enough rows to prove grouping, sorting and
// severity-band rendering, and no more.
const DATA_FEEDS = ['subnets', 'leases', 'hosts', 'zones', 'dnsViews', 'secPolicies', 'feeds', 'auditLogs'];

// util drives the "≥N% full" bands, so the three rows sit either side of the
// thresholds rather than clustering: one healthy, one warn, one critical.
const SUBNETS = [
  { id: 'ipam/subnet/baseline-1', addr: '10.10.0.0', cidr: 24, name: 'baseline-net-a', site: 'baseline-site', total: 254, used: 25, util: 10 },
  { id: 'ipam/subnet/baseline-2', addr: '10.20.0.0', cidr: 24, name: 'baseline-net-b', site: 'baseline-site', total: 254, used: 215, util: 85 },
  { id: 'ipam/subnet/baseline-3', addr: '10.30.0.0', cidr: 24, name: 'baseline-net-c', site: 'other-site', total: 254, used: 249, util: 98 },
];
const LEASES = [
  { addr: '10.10.0.5', host: 'baseline-host-a', state: 'active', subnet: '10.10.0.0/24', subnet_id: 'ipam/subnet/baseline-1' },
  { addr: '10.20.0.9', host: 'baseline-host-b', state: 'expired', subnet: '10.20.0.0/24', subnet_id: 'ipam/subnet/baseline-2' },
];
const HOSTS = [
  { id: 'infra/host/baseline-1', ip: '10.10.0.2', name: 'baseline-host-a', status: 'ok', type: 'onprem' },
  { id: 'infra/host/baseline-2', ip: '10.20.0.2', name: 'baseline-host-b', status: 'degraded', type: 'onprem' },
];
const ZONES = [
  { id: 'dns/auth_zone/baseline-1', fqdn: 'baseline.example.', view: 'baseline-view', records: 12, ttl: 3600, neg_ttl: 900, dnssec_status: 'SIGNED', anomaly: false, issues: [] },
  { id: 'dns/auth_zone/baseline-2', fqdn: 'other.example.', view: 'baseline-view', records: 3, ttl: 300, neg_ttl: 900, dnssec_status: 'UNSIGNED', anomaly: true, issues: ['low ttl'] },
];
const DNS_VIEWS = [{ id: 'dns/view/baseline-1', name: 'baseline-view', comment: 'the only view' }];
const SEC_POLICIES = [
  { id: 'sec/policy/baseline-1', name: 'baseline-policy', action: 'block', active: true, created: agoIso(48 * HOUR), rules: 4 },
];
const FEEDS = [
  { id: 1, name: 'baseline-feed', cat: 'malware', conf: 'high', entries: 1200, level: 'high', active: true },
  { id: 2, name: 'baseline-feed-off', cat: 'phishing', conf: 'medium', entries: 40, level: 'medium', active: false },
];

const dataPayload = () => ({
  subnets: SUBNETS,
  leases: LEASES,
  hosts: HOSTS,
  zones: ZONES,
  dnsViews: DNS_VIEWS,
  secPolicies: SEC_POLICIES,
  feeds: FEEDS,
  auditLogs: CSP_AUDIT_ROWS,
  _totals: { degraded: false, hosts: HOSTS.length, subnets: SUBNETS.length, subnetsCrit: 1, subnetsWarn: 1 },
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

const CSP_AUDIT = { status: 'ok', truncated: false, count: CSP_AUDIT_ROWS.length, rows: CSP_AUDIT_ROWS };

const SPACES = { spaces: [{ id: 'ipam/ip_space/baseline-1', name: 'Baseline Space' }] };
// The picker's zone shape, which is NOT /api/data's zone shape — that one carries
// dnssec_status, records, ttl and issues. Two different reads of the same object.
const DNS_ZONES_PICKER = { zones: [{ id: 'dns/auth_zone/baseline-1', fqdn: 'baseline.example.', name: 'baseline.example.' }] };

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

// --- daily / security -------------------------------------------------------
const HUB_SECURITY = {
  availability: 'ok',
  blocked: 12,
  logged: 8,
  total: 20,
  counts: { critical: 1, high: 2, medium: 3, low: 4 },
  events: [
    { device: 'baseline-device-a', event_time: agoIso(2 * HOUR), feed_name: 'baseline-feed', network: 'baseline-net-a', policy_action: 'BLOCK', qname: 'bad.baseline.example', severity: 'HIGH', threat_indicator: 'baseline-indicator-1' },
    { device: 'baseline-device-b', event_time: agoIso(4 * HOUR), feed_name: 'baseline-feed', network: 'baseline-net-b', policy_action: 'LOG', qname: 'watch.baseline.example', severity: 'MEDIUM', threat_indicator: 'baseline-indicator-2' },
  ],
};

// The service types this tenant "owns". tests/hidden-panels.spec.ts proves panels
// for unowned services are hidden, so this list decides which panels exist at
// all — `dns` is in it deliberately, otherwise the DNS tab's panels vanish and
// the baseline records their absence as normal.
const SERVICE_INVENTORY = { availability: 'ok', service_types: ['dfp', 'dhcp', 'dns', 'discovery', 'ntp', 'orpheus'] };

// --- network ----------------------------------------------------------------
const DHCP_LEASES = {
  status: 'ok',
  count: 2,
  rows: [
    { address: '10.10.0.5', ends: agoIso(-6 * HOUR), hardware: '00:00:5e:00:53:01', hostname: 'baseline-host-a', state: 'active' },
    { address: '10.20.0.9', ends: agoIso(1 * HOUR), hardware: '00:00:5e:00:53:02', hostname: 'baseline-host-b', state: 'expired' },
  ],
};
const IPAM_UTIL = {
  status: 'ok',
  count: 2,
  rows: [
    { id: 'ipam/ip_space/baseline-1', label: 'Baseline Space', pct: 42, total: 1024, used: 430 },
    { id: 'ipam/ip_space/baseline-2', label: 'Other Space', pct: 91, total: 256, used: 233 },
  ],
};

// --- dns --------------------------------------------------------------------
const DNS_SERVICES = { status: 'ok', count: 1, rows: [{ comment: 'baseline', id: 'dns/service/baseline-1', name: 'baseline-dns-service', pool_id: 'pool/baseline-1' }] };
const DNSSEC = {
  status: 'ok',
  count: 2,
  summary: { SIGNED: 1, UNSIGNED: 1 },
  rows: [
    { dnssec_signing_policy: 'default', dnssec_status: 'SIGNED', fqdn: 'baseline.example.', id: 'dns/auth_zone/baseline-1', view: 'baseline-view' },
    { dnssec_signing_policy: '', dnssec_status: 'UNSIGNED', fqdn: 'other.example.', id: 'dns/auth_zone/baseline-2', view: 'baseline-view' },
  ],
};
const DTC_LBDN = { status: 'ok', count: 1, rows: [{ comment: 'baseline', disabled: false, dtc_policy: 'baseline-policy', name: 'baseline-lbdn', precedence: 10, ttl: 300, view: 'baseline-view' }] };
const RPZ = { status: 'ok', count: 1, rows: [{ comment: 'baseline', disabled: false, fqdn: 'rpz.baseline.example.', policy_override: 'NONE', priority: '1', severity: 'HIGH', type: 'local' }] };
// Drives Query Volume — 7d. The live server answered this with an EMPTY BODY
// when it was sampled on 2026-08-13, so an empty object looked like the honest
// fake — but it left the panel in its no-data state and two chart-tooltips tests
// with nothing to hover. The row shape is recorded in ui/src/tabs/Dns.jsx:283
// against the live feed on 2026-08-07: {timestamp, "timestamp.day",
// total_query_count}, with no `hour` field despite the code still accepting one.
// Seven days, because the panel is named for seven days and a shorter series
// would not exercise its axis.
const DNS_ANALYTICS = {
  availability: 'ok',
  volume: Array.from({ length: 7 }, (_, i) => {
    const day = agoIso((6 - i) * 24 * HOUR).slice(0, 10);
    return { timestamp: day, 'timestamp.day': day, total_query_count: 1000 + i * 250 };
  }),
};

// --- security ---------------------------------------------------------------
const ASSET_INSIGHTS = { status: 'ok', total: 42, breakdown_available: false, note: 'baseline' };
const EMPTY_DATA_OK = { status: 'ok', data: {} };
const EMPTY_EXPOSURE_OK = { status: 'ok', availability: 'ok', data: {}, reason: '' };
const THREATS = {
  status: 'ok',
  count: 2,
  rows: [
    { action: 'BLOCK', day: agoIso(48 * HOUR).slice(0, 10), requests: 120 },
    { action: 'LOG', day: agoIso(24 * HOUR).slice(0, 10), requests: 45 },
  ],
};
const INSIGHTS = {
  availability: 'ok',
  data: [
    { currentStatus: 'Active', feedSource: 'baseline-feed', id: 'insight/baseline-1', mostRecentAt: agoIso(2 * HOUR), name: 'Baseline Insight', severity: 'HIGH', startedAt: agoIso(72 * HOUR), timeSaved: null, totalEvents: 9, totalVerifiedAssets: null },
  ],
};
const LOOKALIKES = {
  unavailable: null,
  targets: ['baseline.example'],
  domains: [
    { detected_at: agoIso(6 * HOUR), host: 'baseline-host-a', lookalike: 'baselíne.example', reason: 'homoglyph', suspicious: true, target: 'baseline.example' },
  ],
};

// --- infra ------------------------------------------------------------------
const DFP = { status: 'ok', count: 1, rows: [{ id: 1, name: 'baseline-dfp', status: 'ok' }] };
const DISCOVERY_STATUS = { status: 'ok', total: 7, breakdown_available: false, note: 'baseline' };
const HOST_HEALTH = { status: 'ok', count: 1, rows: [{ ip: '10.10.0.2', location: 'baseline-site', name: 'baseline-host-a', nat_ip: '', status: 'ok', version: '0.0.0-baseline' }] };
const JOBS = { status: 'ok', count: 1, rows: [{ created_at: agoIso(3 * HOUR), id: 'job/baseline-1', status: 'completed', type: 'discovery', user: 'baseline-operator' }] };
const MAINTENANCE = { status: 'ok', enabled: false };
const ONPREM_HOSTS = { status: 'ok', count: 1, rows: [{ app_count: 2, apps: [], name: 'baseline-onprem-a', ophid: 'ophid-baseline-1' }] };

// --- assets / dossier -------------------------------------------------------
const ASSET_FILTERS = { availability: 'ok', total: 2, types: [{ count: 1, label: 'Server' }, { count: 1, label: 'Router' }] };
const ASSETS = {
  availability: 'ok',
  dir: 'asc',
  sort: 'name',
  page: 1,
  page_size: 50,
  has_more: false,
  total: 1,
  rows: [{ cqid: 'cq/baseline-1', last_seen: agoIso(5 * HOUR), name: 'baseline-asset-a', provider: 'baseline-provider', type: 'Server', vendor: 'baseline-vendor' }],
};
const DOSSIER = {
  query: 'baseline.example',
  type: 'host',
  unavailable: null,
  summary: { actor: 'baseline-actor', country: 'ZZ', malicious: false, max_threat_level: 0, properties: [], registrar: 'baseline-registrar', threat_classes: [] },
  sources: [
    { source: 'baseline-source-a', detail: '{"note":"baseline"}' },
    { source: 'baseline-source-b', detail: '{"note":"baseline"}' },
  ],
};
const SEARCH_DNS = { availability: 'ok', limit: 50, truncated: false, rows: [{ fqdn: 'baseline.example.', type: 'A', value: '10.10.0.5', view: 'baseline-view' }] };

// --- incidents --------------------------------------------------------------
// Epoch SECONDS here, not an ISO string — measured from the live server, and the
// UI's age column divides by 1000 nowhere.
const epochSec = (msAgo: number) => (FIXED_NOW.getTime() - msAgo) / 1000;
const INCIDENTS = {
  _meta: { leases: 'ok', subnets: 'ok', zones: 'ok' },
  incidents: [
    { category: 'capacity', count: 2, entity_type: 'subnet', first_detected_at: epochSec(8 * HOUR), key: 'capacity/subnet', message: 'subnets close to full', sample_entities: ['ipam/subnet/baseline-3'], severity: 'high' },
  ],
  signals: [
    { category: 'capacity', detected_at: epochSec(3 * HOUR), entity_id: 'ipam/subnet/baseline-3', entity_type: 'subnet', message: 'baseline-net-c is 98% used', severity: 'critical', source: 'baseline' },
    { category: 'dns', detected_at: epochSec(1 * HOUR), entity_id: 'dns/auth_zone/baseline-2', entity_type: 'zone', message: 'other.example is unsigned', severity: 'medium', source: 'baseline' },
  ],
  signals_degraded: false,
  signals_total: 2,
  signals_truncated: false,
  snoozes: {},
};
// Infoblox IQ Actions — the SOC Queue and Action Volume panels. Priority is
// low/medium/high, which the tab maps onto its own severity vocabulary.
const IQ_ACTIONS = {
  success: true,
  availability: 'ok',
  message: '',
  total_count: 2,
  pagination: { has_more: false, limit: 50, offset: 0 },
  actions: [
    { affected: 'baseline.example', created_by_name: 'baseline-analyst', id: 'action/baseline-1', last_activity: agoIso(5 * HOUR), priority: 'high', status: 'active', title: 'Baseline suspicious domain', type: 'investigation' },
    { affected: 'other.example', created_by_name: 'baseline-analyst', id: 'action/baseline-2', last_activity: agoIso(29 * HOUR), priority: 'low', status: 'resolved', title: 'Baseline resolved lookup', type: 'investigation' },
  ],
};

// --- audit ------------------------------------------------------------------
const AUDIT_LOG = {
  chain_valid: true,
  chain_state: 'ok',
  chain_detail: 'baseline chain',
  chain_verify_error: null,
  broken_index: null,
  broken_reason: null,
  append_failures: 0,
  entries: [
    { actor: 'baseline-operator', detail: { from: 'v0.0.0-baseline' }, event: 'update.apply', hash: 'baselinehash1', prev_hash: '', ts: epochSec(6 * HOUR) },
    { actor: 'baseline-operator', detail: { from: 'v0.0.0-baseline' }, event: 'tenant.write', hash: 'baselinehash2', prev_hash: 'baselinehash1', ts: epochSec(2 * HOUR) },
  ],
};

const PER_PAGE: Record<string, Handler[]> = {
  changes: [{ method: 'GET', path: '/api/csp-audit', body: CSP_AUDIT, required: true }],
  drift: [
    { method: 'GET', path: '/api/ipam/spaces', body: SPACES, required: true },
    { method: 'GET', path: '/api/templates', body: TEMPLATES, required: true },
  ],
  selfservice: [
    { method: 'GET', path: '/api/ipam/spaces', body: SPACES, required: true },
    { method: 'GET', path: '/api/dns/zones', body: DNS_ZONES_PICKER, required: true },
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
  daily: [{ method: 'GET', path: '/api/hub/security', body: HUB_SECURITY, required: true }],
  network: [
    { method: 'GET', path: '/api/csp/dhcp-leases', body: DHCP_LEASES, required: true },
    { method: 'GET', path: '/api/csp/ipam-util', body: IPAM_UTIL, required: true },
    { method: 'GET', path: '/api/service-inventory', body: SERVICE_INVENTORY, required: true },
  ],
  dns: [
    { method: 'GET', path: '/api/csp/dns-qps', body: DNS_QPS, required: true },
    { method: 'GET', path: '/api/csp/dns-services', body: DNS_SERVICES, required: true },
    { method: 'GET', path: '/api/csp/dnssec', body: DNSSEC, required: true },
    { method: 'GET', path: '/api/csp/dtc-lbdn', body: DTC_LBDN, required: true },
    { method: 'GET', path: '/api/csp/rpz', body: RPZ, required: true },
    { method: 'GET', path: '/api/dns-analytics', body: DNS_ANALYTICS, required: true },
    { method: 'GET', path: '/api/service-inventory', body: SERVICE_INVENTORY, required: true },
  ],
  security: [
    { method: 'GET', path: '/api/csp/asset-insights', body: ASSET_INSIGHTS, required: true },
    { method: 'GET', path: '/api/csp/asset-risk', body: EMPTY_DATA_OK, required: true },
    { method: 'GET', path: '/api/csp/ctem-assets', body: EMPTY_DATA_OK, required: true },
    { method: 'GET', path: '/api/csp/ctem-exposure', body: EMPTY_DATA_OK, required: true },
    { method: 'GET', path: '/api/csp/exposed-hostnames', body: EMPTY_EXPOSURE_OK, required: true },
    { method: 'GET', path: '/api/csp/exposed-ips', body: EMPTY_EXPOSURE_OK, required: true },
    { method: 'GET', path: '/api/csp/exposures', body: EMPTY_EXPOSURE_OK, required: true },
    { method: 'GET', path: '/api/csp/threats', body: THREATS, required: true },
    { method: 'GET', path: '/api/hub/security', body: HUB_SECURITY, required: true },
    { method: 'GET', path: '/api/insights', body: INSIGHTS, required: true },
    { method: 'GET', path: '/api/lookalikes', body: LOOKALIKES, required: true },
    { method: 'GET', path: '/api/service-inventory', body: SERVICE_INVENTORY, required: true },
  ],
  infra: [
    { method: 'GET', path: '/api/csp/dfp', body: DFP, required: true },
    { method: 'GET', path: '/api/csp/discovery-status', body: DISCOVERY_STATUS, required: true },
    { method: 'GET', path: '/api/csp/host-health', body: HOST_HEALTH, required: true },
    { method: 'GET', path: '/api/csp/jobs', body: JOBS, required: true },
    { method: 'GET', path: '/api/csp/maintenance', body: MAINTENANCE, required: true },
    { method: 'GET', path: '/api/csp/onprem-hosts', body: ONPREM_HOSTS, required: true },
  ],
  assets: [
    { method: 'GET', path: '/api/csp/asset-filters', body: ASSET_FILTERS, required: true },
    { method: 'GET', path: '/api/csp/assets', body: ASSETS, required: true },
  ],
  incidents: [
    { method: 'GET', path: '/api/actions', body: IQ_ACTIONS, required: true },
    { method: 'GET', path: '/api/incidents', body: INCIDENTS, required: true },
  ],
  audit: [
    { method: 'GET', path: '/api/audit/log', body: AUDIT_LOG, required: true },
    { method: 'GET', path: '/api/csp-audit', body: CSP_AUDIT, required: true },
  ],
  // The AI tab calls nothing of its own on load — /api/query, /api/dossier and
  // /api/threat-lookup are all on submit. Measured by probe, and the opposite of
  // what a grep of Ai.jsx suggests.
  ai: [],
  dossier: [
    { method: 'GET', path: '/api/dossier', body: DOSSIER, required: true },
    { method: 'GET', path: '/api/search/dns', body: SEARCH_DNS, required: true },
    { method: 'GET', path: '/api/csp/assets', body: ASSETS, required: true },
  ],
};

// Shell endpoints a given page legitimately does not call. Without this, the
// "required fixture never requested" check would fail every dossier run.
// Measured by probe: #dossier issues no /api/views request because it has no
// panel grid to arrange.
const SHELL_EXEMPT: Record<string, string[]> = {
  dossier: ['GET /api/views'],
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
/**
 * Every page's handlers merged into one set, for specs that move BETWEEN tabs in
 * a single test — tests/tabs-smoke.spec.ts hops from each tab to the next, so
 * fixtures for one page alone would leave the next tab's calls unmatched and
 * aborted, which shows up as exactly the console errors that spec is watching for.
 *
 * Several endpoints appear under more than one page (`/api/csp-audit` under both
 * changes and audit, `/api/csp/assets` under assets and dossier, and so on). That
 * is fine ONLY while the bodies are identical, so this refuses to merge two
 * different bodies for the same method+path rather than silently letting one page
 * win and giving the other a body it never asked for.
 */
function mergedHandlers(): Handler[] {
  const byKey = new Map<string, Handler>();
  for (const [pageId, list] of Object.entries(PER_PAGE)) {
    for (const h of list) {
      const key = `${h.method} ${h.path}`;
      const seen = byKey.get(key);
      if (seen && JSON.stringify(seen.body) !== JSON.stringify(h.body)) {
        throw new Error(
          `page-fixtures: "${key}" is defined with two different bodies (last seen before "${pageId}"). ` +
            `Merge them into one shared constant, or the merged fixture set silently serves one page the other's data.`,
        );
      }
      if (!seen) byKey.set(key, h);
    }
  }
  return [...byKey.values()];
}

/** Pass this instead of a page id to serve every page's fixtures at once. */
export const ALL_PAGES = '*';

/**
 * Frozen clock plus every page's fixtures — the whole app, deterministic, with
 * no upstream. This is what took 7 spec files off playwright.config.ts's
 * LIVE_TENANT_SPECS list: they were excluded from CI because they assert on data
 * only a real tenant serves, and this IS a tenant, the same one on every machine.
 *
 * Install it in a `beforeEach`. A spec that needs one endpoint to behave
 * differently — tests/hub-security-availability.spec.ts fakes a DEAD feed on
 * purpose — just calls page.route for that path inside the test body; Playwright
 * matches handlers newest-first, so the specific one wins over this catch-all.
 */
export async function installBaselineWorld(page: Page): Promise<FixtureSession> {
  await page.clock.setFixedTime(FIXED_NOW);
  return installFixtures(page, ALL_PAGES);
}

export async function installFixtures(page: Page, pageId: string): Promise<FixtureSession> {
  const handlers =
    pageId === ALL_PAGES ? [...SHELL, ...mergedHandlers()] : [...SHELL, ...(PER_PAGE[pageId] ?? [])];
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

  const exempt = new Set(SHELL_EXEMPT[pageId] ?? []);
  return {
    unmatched: () => [...new Set(unmatched)].sort(),
    // Meaningless in merged mode and deliberately switched off there: a test that
    // visits two tabs cannot be expected to call all sixteen pages' endpoints, so
    // the check would fail every time and teach whoever hit it to ignore this
    // file. `unmatched` still applies in both modes and is the half that catches
    // a page asking for something new.
    neverCalled: () =>
      pageId === ALL_PAGES
        ? []
        : handlers
            .filter((h) => h.required && !hit.has(`${h.method} ${h.path}`) && !exempt.has(`${h.method} ${h.path}`))
            .map((h) => `${h.method} ${h.path}`),
  };
}
