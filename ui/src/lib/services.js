import { useSyncExternalStore } from 'react'

// Which service types this tenant actually has deployed, from
// GET /api/service-inventory (go/internal/dashboard/hub.go,
// FetchServiceInventory -> /api/infra/v1/detail_services).
//
// This is the only code in the app that REMOVES a panel from the page.
// Everywhere else a broken feed still leaves a card on screen saying it is
// broken (<FeedUnavailable/>); here a wrong answer makes the panel vanish, and
// nothing on screen distinguishes "you don't own this" from "we couldn't ask".
// So the rule is one-directional: hide ONLY on an authoritative answer, show
// on everything else. That is the same failure-reads-as-safety class the
// comment in FetchHubHealth's error branch (hub.go:42-45) exists to close,
// pointed at absence instead of at zero.
//
// The wire contract, three states, not two:
//   ok      — service_types is the complete list. [] means the tenant really
//             does deploy nothing, and IS authoritative.
//   error   — the read failed. service_types is null, never [].
//   partial — the response hit the 500-row limit, so a type that is absent
//             cannot be told apart from one that was truncated away. The types
//             listed are real, but the SET is not, so it is treated as unknown.
//
// This file is deliberately .js and not .jsx: `npm test` is bare `node --test`,
// which cannot load a .jsx extension, and the fail-open decision below is the
// part that most needs a test. The one piece of JSX this feature needs lives in
// components/ui.jsx as <HiddenPanels/>.

const INVENTORY_URL = '/api/service-inventory'

/**
 * Reduce an /api/service-inventory body to what the UI may act on.
 *
 * @param inventory the parsed response body, or null when the read has not
 *   landed yet, was aborted, or threw.
 * @returns {{owned: Set<string>|null, unavailable: boolean, reason?: string}}
 *   `owned` is null whenever ownership is UNKNOWN — never an empty Set, which
 *   would read as "owns nothing" and hide panels on a dead feed.
 */
export function ownedServices(inventory) {
  const types = inventory?.service_types
  if (inventory?.availability !== 'ok' || !Array.isArray(types)) {
    return { owned: null, unavailable: true, reason: inventory?.reason }
  }
  return { owned: new Set(types), unavailable: false }
}

/**
 * Should a panel requiring ANY of `required` service types be hidden?
 * True only when ownership is known AND none of the required types is owned.
 */
export function shouldHidePanel(state, required) {
  if (!state?.owned) return false
  if (!Array.isArray(required) || required.length === 0) return false
  return !required.some((t) => state.owned.has(t))
}

// ---------- the panel -> service map ----------
//
// Each entry is justified by the UPSTREAM the panel's feed actually reads, not
// by which tab it sits on. A panel is mapped only when its rows are produced by
// a deployed service that detail_services reports; a panel fed by cloud
// configuration or by a subscription (zones, IPAM, CTEM, exposures, threat
// feeds, lookalikes, SOC insights) is deliberately NOT mapped — those exist
// with no service deployed at all, so hiding them on this signal would be
// wrong for every tenant.
//
//   dns  ['dns','ndns']       DNS Services  /api/csp/dns-services
//                               -> /api/ddi/v1/dns/service (csp.go CSPDNSServices):
//                                  the DNS service objects themselves.
//                             DNS Query Rate — 24h  /api/csp/dns-qps
//                               -> cubejs HostMetrics, metric dns_qps_iq
//                                  (csp.go CSPDNSQps): a per-host metric only a
//                                  deployed DNS service emits.
//   dhcp ['dhcp','ndhcp']     DHCP Leases  /api/csp/dhcp-leases
//                               -> /api/ddi/v1/dhcp/lease (csp.go CSPDHCPLeases):
//                                  leases are issued by a deployed DHCP service.
//   dfp  ['dfp','orpheus']    Threat Events by Severity / Response Summary /
//                             Triage Inbox — all three read /api/hub/security
//                               -> /api/dnsdata/v2/dns_event (hub.go
//                                  FetchHubSecurity): DNS threat events, which
//                                  come from the forwarding-proxy tier. Same two
//                                  types hubBuckets already calls "Security"
//                                  (hub.go:24).
//
// Both flavours of each pair are listed because a panel needs ANY of them: a
// tenant running only ndns still has DNS services worth showing.
export const SERVICE_GROUPS = {
  dns: { services: ['dns', 'ndns'], label: 'DNS' },
  dhcp: { services: ['dhcp', 'ndhcp'], label: 'DHCP' },
  threatDefense: { services: ['dfp', 'orpheus'], label: 'threat-defense' },
}

// ---------- store ----------
//
// ONE fetch per page load, shared by every wrapper on every tab. Not useApi():
// that hook fetches per calling component and the tabs that need this poll on a
// 30s interval (Security.jsx), and ownership is not a 30s-scale fact — joining
// that loop would add a request every 30 seconds forever for an answer that
// cannot change while the page is open. `started` is the guard that makes the
// fetch exactly-once regardless of how many wrappers mount or re-mount.
//
// A module-level store rather than a React context provider because App.jsx
// mounts every tab and nothing in this feature needs to be scoped to a subtree;
// useSyncExternalStore gives the same shared-and-reactive result without a
// provider having to be threaded through the app shell.

const REVEAL_PREFIX = 'bx:show-anyway:'

function readRevealed() {
  const out = new Set()
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(REVEAL_PREFIX)) out.add(k.slice(REVEAL_PREFIX.length))
    }
  } catch {
    // No sessionStorage (private mode, sandboxed iframe): "show anyway" still
    // works, it just stops surviving a reload.
  }
  return out
}

// Starts as unknown, which is the fail-open state: until the read lands,
// everything renders.
let snapshot = { owned: null, unavailable: true, revealed: readRevealed() }
let started = false
const listeners = new Set()

function emit(next) {
  snapshot = next
  for (const l of listeners) l()
}

function start() {
  if (started) return
  started = true
  fetch(INVENTORY_URL, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => emit({ ...ownedServices(body), revealed: snapshot.revealed }))
    .catch(() => emit({ ...ownedServices(null), revealed: snapshot.revealed }))
}

function subscribe(listener) {
  listeners.add(listener)
  start()
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return snapshot
}

/** Reveal one hidden group for the rest of this browser session. */
export function showAnyway(groupKey) {
  if (snapshot.revealed.has(groupKey)) return
  try {
    sessionStorage.setItem(REVEAL_PREFIX + groupKey, '1')
  } catch {
    // See readRevealed: unavailable storage costs stickiness, not the reveal.
  }
  emit({ ...snapshot, revealed: new Set(snapshot.revealed).add(groupKey) })
}

/**
 * The shared owned-service state: { owned: Set|null, unavailable, revealed }.
 * owned === null means UNKNOWN, and unknown means hide nothing.
 */
export function useOwnedServices() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
