import type { Subnet, Severity } from '../types/network';
import { SeverityBadge } from './SeverityBadge';
import './SubnetsTable.css';

function utilVar(severity: Severity): string {
  if (severity === 'crit') return 'var(--red)';
  if (severity === 'warn') return 'var(--amber)';
  return 'var(--green)';
}

export function SubnetsTable({ subnets }: { subnets: Subnet[] }) {
  const hasSite = subnets.some((s) => !!s.site);
  const hasOwner = subnets.some((s) => s.owner && s.owner !== '–');

  return (
    <table className="subnets-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Network</th>
          {hasSite && <th>Site</th>}
          {hasOwner && <th>Owner</th>}
          <th>Used / Total</th>
          <th>Utilization</th>
          <th>Severity</th>
        </tr>
      </thead>
      <tbody>
        {subnets.map((s) => (
          <tr key={s.id} id={`subnet-${s.id}`}>
            <td>{s.name}</td>
            <td className="subnets-mono">
              {s.addr}/{s.cidr}
            </td>
            {hasSite && <td>{s.site}</td>}
            {hasOwner && <td>{s.owner}</td>}
            <td className="subnets-mono">
              {s.used} / {s.total}
            </td>
            <td>
              <div className="subnets-util">
                <div className="subnets-bar-track">
                  <div
                    className="subnets-bar-fill"
                    style={{ width: `${s.util}%`, background: utilVar(s.severity) }}
                  />
                  <div
                    className="subnets-marker"
                    style={{ left: '75%' }}
                    title="75% warning"
                  />
                  <div
                    className="subnets-marker"
                    style={{ left: '90%' }}
                    title="90% critical"
                  />
                </div>
                <span className="subnets-util-text">{s.util}%</span>
              </div>
            </td>
            <td>
              <SeverityBadge severity={s.severity} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
