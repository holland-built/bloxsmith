export type Health = 'crit' | 'warn' | 'ok';

export interface ServiceHealth {
  name: string;
  status: Health;
  statusLabel: string;
  meta: string;
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
  sparkline: number[]; // points for the trending sparkline
}
