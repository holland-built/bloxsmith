export type Sev = 'crit' | 'warn' | 'ok';

export interface ThreatFeed {
  name: string;
  source: string;
  threat_level: string;
  confidence: string;
  severity: Sev;
}

export interface NamedList {
  name: string;
  type: string;
  items: number;
  threat_level: string;
  policies: number;
  severity: Sev;
}

export interface SecurityPolicy {
  name: string;
  default_action: string;
  dfps: number;
  rules: number;
  doh: boolean;
}

export interface RoamingEndpoints {
  total: number;
  by_status: Record<string, number>;
  top_countries: [string, number][];
}

export interface AnycastHA {
  name: string;
  service: string;
  ip: string;
  state: string;
  severity: Sev;
}

export interface DfpService {
  name: string;
  mode: string;
  host: string;
  resolvers: number;
}

export interface HostInventory {
  total: number;
  by_status: Record<string, number>;
  hosts: { name: string; ip: string; version: string; status: string; qps: number }[];
}

export interface HubDomains {
  threat_feeds: ThreatFeed[];
  named_lists: NamedList[];
  security_policies: SecurityPolicy[];
  roaming_endpoints: RoamingEndpoints;
  anycast_ha: AnycastHA[];
  dfp_services: DfpService[];
  host_inventory: HostInventory;
}
