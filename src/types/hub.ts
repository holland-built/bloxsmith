export type Health = 'crit' | 'warn' | 'ok';

export interface ServiceHealth {
  name: string;
  status: Health;
  statusLabel: string;
  meta: string;
}

export interface SecurityEvent {
  event_time: string;
  qname: string;
  severity: string;
  policy_action: string;
  feed_name: string;
  threat_indicator: string;
  device: string;
  network: string;
}

export interface SecurityFeed {
  events: SecurityEvent[];
  counts: { critical: number; high: number; medium: number; low: number };
  blocked: number;
  logged: number;
  total: number;
}

export interface HubMetrics {
  critIncidents: { title: string; target: string; age: string }[];
  oversubscribed: { cidr: string; util: number; severity: 'crit' | 'warn' | 'ok' }[];
  critCount: number;
  anomaliesPerHr: number;
  anomaliesPrevHr: number;
  anomalyMultiplier: number; // e.g. 3 for "3x"
  newIncidents: number; // opened recently
  warnBacklog: number;
  openOver48h: number;
  services: ServiceHealth[]; // DNS, DHCP, IPAM, Security
  security: { critical: number; high: number; medium: number; low: number };
  securityBlocked: number; // real threat-defense blocked actions (last hr)
  securityLogged: number; // real threat-defense logged actions (last hr)
  securityReal: boolean; // true when counts come from live DNS events, not derived
  healthReal: boolean; // true when DNS/DHCP/Security rows come from live infra data
  sparkline: number[]; // points for the trending sparkline
}
