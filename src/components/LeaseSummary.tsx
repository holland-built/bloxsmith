import type { Lease } from '../types/network';
import './LeaseSummary.css';

export function LeaseSummary({ leases }: { leases: Lease[] }) {
  const active = leases.filter((lease) => lease.state === 'active').length;
  const expired = leases.filter((lease) => lease.state === 'expired').length;
  const subnetCount = new Set(leases.map((lease) => lease.subnet)).size;

  return (
    <div className="lease-summary">
      <div className="lease-stat">
        <div className="lease-stat-value lease-stat-active">{active}</div>
        <div className="lease-stat-label">Active Leases</div>
      </div>
      <div className="lease-stat">
        <div className="lease-stat-value lease-stat-expired">{expired}</div>
        <div className="lease-stat-label">Expired Leases</div>
      </div>
      <div className="lease-stat">
        <div className="lease-stat-value lease-stat-subnets">{subnetCount}</div>
        <div className="lease-stat-label">Subnets with Leases</div>
      </div>
    </div>
  );
}
