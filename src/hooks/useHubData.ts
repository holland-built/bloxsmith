import { useMemo } from 'react';
import { useMcpIncidents } from './useMcpIncidents';
import { useMcpEvents } from './useMcpEvents';
import { useNetworkData } from './useNetworkData';
import { useHubHealth } from './useHubHealth';
import { useHubSecurity } from './useHubSecurity';
import type { McpIncident, McpEvent } from '../types/mcp';
import type { Subnet } from '../types/network';
import type { HubMetrics, Health, ServiceHealth, SecurityFeed } from '../types/hub';

const MIN = 60 * 1000;
const RANK: Record<Health, number> = { ok: 0, warn: 1, crit: 2 };

interface UseHubDataResult {
  metrics: HubMetrics | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

function msAgo(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NaN;
  return Math.max(0, Date.now() - t);
}

function relativeAge(iso: string): string {
  const diff = msAgo(iso);
  if (Number.isNaN(diff)) return '—';
  const mins = Math.floor(diff / MIN);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function worst(a: Health, b: Health): Health {
  return RANK[a] >= RANK[b] ? a : b;
}

function statusLabel(h: Health): string {
  return h === 'crit' ? 'critical' : h === 'warn' ? 'degraded' : 'healthy';
}

function worstFor(incidents: McpIncident[], re: RegExp): Health {
  return incidents
    .filter((i) => re.test(i.type) || re.test(i.title))
    .reduce<Health>((acc, i) => worst(acc, i.severity), 'ok');
}

function deriveMetrics(
  incidents: McpIncident[],
  events: McpEvent[],
  subnets: Subnet[],
  realHealth: ServiceHealth[] | null,
  realSecurity: SecurityFeed | null
): HubMetrics {
  // --- FIRE: critical incidents ---
  const critList = incidents.filter((i) => i.severity === 'crit');
  const critIncidents = critList.slice(0, 5).map((i) => ({
    title: i.title,
    target: i.type || String(i.affected),
    age: relativeAge(i.last_activity),
  }));
  const critCount = critList.length;

  // --- FIRE: oversubscribed subnets ---
  const oversubscribed = subnets
    .filter((s) => s.util >= 85)
    .sort((a, b) => b.util - a.util)
    .slice(0, 4)
    .map((s) => ({ cidr: `${s.addr}/${s.cidr}`, util: s.util, severity: s.severity }));

  // --- TRENDING: anomaly rate ---
  let perHr = 0;
  let prevHr = 0;
  let anyInRange = false;
  for (const ev of events) {
    const age = msAgo(ev.event_timestamp);
    if (Number.isNaN(age)) continue;
    if (age < 60 * MIN) {
      perHr += 1;
      anyInRange = true;
    } else if (age < 120 * MIN) {
      prevHr += 1;
      anyInRange = true;
    }
  }
  if (!anyInRange) perHr = events.length; // fallback: no parseable timestamps in range
  const anomaliesPerHr = perHr;
  const anomaliesPrevHr = prevHr;
  const anomalyMultiplier = Math.round(perHr / Math.max(prevHr, 1));

  // --- TRENDING: new incidents (last 20 min) ---
  const newIncidents = incidents.filter((i) => {
    const age = msAgo(i.last_activity);
    return !Number.isNaN(age) && age <= 20 * MIN;
  }).length;

  // --- FOLLOW-UP ---
  const warnBacklog = incidents.filter((i) => i.severity === 'warn').length;
  const openOver48h = incidents.filter((i) => {
    const resolved = /resolv|closed|done/i.test(i.status);
    if (resolved) return false;
    const age = msAgo(i.last_activity);
    return !Number.isNaN(age) && age > 48 * 60 * MIN;
  }).length;

  // --- HEALTH: per-service rollup ---
  const maxUtil = subnets.reduce((m, s) => Math.max(m, s.util), 0);
  const oversubCount = subnets.filter((s) => s.util >= 85).length;

  const dnsH = worstFor(incidents, /dns|servfail|nxdomain|resolver/i);
  let dhcpH = worstFor(incidents, /dhcp|lease|pool/i);
  if (maxUtil >= 95) dhcpH = worst(dhcpH, 'crit');
  const ipamH: Health = maxUtil >= 95 ? 'crit' : maxUtil >= 85 ? 'warn' : 'ok';
  const secH = worstFor(incidents, /security|threat|malware|rpz/i);

  const dnsCount = incidents.filter((i) => /dns|servfail|nxdomain|resolver/i.test(i.type) || /dns|servfail|nxdomain|resolver/i.test(i.title)).length;
  const dhcpCount = incidents.filter((i) => /dhcp|lease|pool/i.test(i.type) || /dhcp|lease|pool/i.test(i.title)).length;
  const secCrit = incidents.filter(
    (i) => (/security|threat|malware|rpz/i.test(i.type) || /security|threat|malware|rpz/i.test(i.title)) && i.severity === 'crit'
  ).length;

  // Derived rollup (fallback). Real infra health overrides DNS/DHCP/Security below.
  const derivedServices: Record<string, ServiceHealth> = {
    DNS: { name: 'DNS', status: dnsH, statusLabel: statusLabel(dnsH), meta: dnsCount ? `${dnsCount} alert${dnsCount === 1 ? '' : 's'}` : 'nominal' },
    DHCP: { name: 'DHCP', status: dhcpH, statusLabel: statusLabel(dhcpH), meta: maxUtil >= 95 ? `pool ${maxUtil}%` : dhcpCount ? `${dhcpCount} alert${dhcpCount === 1 ? '' : 's'}` : 'nominal' },
    IPAM: { name: 'IPAM', status: ipamH, statusLabel: statusLabel(ipamH), meta: oversubCount ? `${oversubCount} oversub` : 'nominal' },
    Security: { name: 'Security', status: secH, statusLabel: statusLabel(secH), meta: `${secCrit} crit` },
  };

  const healthReal = !!realHealth && realHealth.length > 0;
  // Real infra health backs DNS/DHCP/Security; IPAM has no infra service so it
  // stays derived from subnet utilization.
  const realByName: Record<string, ServiceHealth> = {};
  for (const r of realHealth ?? []) realByName[r.name] = r;
  const services: ServiceHealth[] = ['DNS', 'DHCP', 'IPAM', 'Security'].map(
    (name) => realByName[name] ?? derivedServices[name]
  );

  // --- SECURITY action counts ---
  const securityReal = !!realSecurity;
  const okCount = incidents.filter((i) => i.severity === 'ok').length;
  const security = realSecurity
    ? realSecurity.counts
    : {
        critical: critCount,
        high: warnBacklog,
        medium: Math.ceil(okCount / 2),
        low: Math.floor(okCount / 2),
      };
  const securityBlocked = realSecurity?.blocked ?? 0;
  const securityLogged = realSecurity?.logged ?? 0;

  // --- TRENDING: sparkline (9 bins over last hour) ---
  const bins = new Array<number>(9).fill(0);
  let binned = 0;
  const binSpan = (60 * MIN) / 9;
  for (const ev of events) {
    const age = msAgo(ev.event_timestamp);
    if (Number.isNaN(age) || age >= 60 * MIN) continue;
    const fromEnd = Math.floor(age / binSpan); // 0 = most recent
    const idx = Math.min(8, Math.max(0, 8 - fromEnd));
    bins[idx] += 1;
    binned += 1;
  }
  const sparkline = binned > 0 ? bins : [1, 1, 2, 2, 3, 3, 4, 5, 6];

  return {
    critIncidents,
    oversubscribed,
    critCount,
    anomaliesPerHr,
    anomaliesPrevHr,
    anomalyMultiplier,
    newIncidents,
    warnBacklog,
    openOver48h,
    services,
    security,
    securityBlocked,
    securityLogged,
    securityReal,
    healthReal,
    sparkline,
  };
}

export function useHubData(): UseHubDataResult {
  const inc = useMcpIncidents();
  const evt = useMcpEvents();
  const net = useNetworkData();
  const hlt = useHubHealth();
  const sec = useHubSecurity();

  // Core sources gate loading; health/security are best-effort overlays that
  // fall back to derived values, so they never block or fail the whole hub.
  const loading = inc.loading || evt.loading || net.loading;
  const error = inc.error && evt.error && net.error ? inc.error : null;

  const refetch = () => {
    inc.refetch();
    evt.refetch();
    net.refetch();
    hlt.refetch();
    sec.refetch();
  };

  const metrics = useMemo<HubMetrics | null>(() => {
    if (loading) return null;
    if (!inc.data && !evt.data && !net.data) return null;
    return deriveMetrics(
      inc.data ?? [],
      evt.data ?? [],
      net.data?.subnets ?? [],
      hlt.data,
      sec.data
    );
  }, [loading, inc.data, evt.data, net.data, hlt.data, sec.data]);

  return { metrics, loading, error, refetch };
}
