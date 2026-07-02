export type Severity = 'crit' | 'warn' | 'ok';

export interface Subnet {
  id: string;
  name: string;
  addr: string;
  cidr: number;
  total: number;
  used: number;
  util: number;
  site?: string;
  owner?: string;
  severity: Severity;
}

export interface Lease {
  addr: string;
  host: string;
  subnet: string;
  subnet_id: string;
  state: 'active' | 'expired';
  severity: Severity;
}

export interface Zone {
  id: string;
  fqdn: string;
  view: string;
  ttl: number;
  neg_ttl: number;
  records: number;
  issues: string[];
  anomaly: boolean;
  severity: Severity;
}

export interface View {
  id: string;
  name: string;
  comment: string;
  severity: Severity;
}

export interface NetworkData {
  subnets: Subnet[];
  leases: Lease[];
  zones: Zone[];
  views: View[];
}
