import type { Zone } from '../types/network';
import { SeverityBadge } from './SeverityBadge';
import './ZonesTable.css';

export function ZonesTable({ zones }: { zones: Zone[] }) {
  return (
    <table className="zones-table">
      <thead>
        <tr>
          <th>FQDN</th>
          <th>View</th>
          <th>TTL</th>
          <th>Neg TTL</th>
          <th>Records</th>
          <th>Issues</th>
          <th>Severity</th>
        </tr>
      </thead>
      <tbody>
        {zones.map((z) => (
          <tr key={z.id} id={`zone-${z.id}`}>
            <td className="zones-mono">{z.fqdn}</td>
            <td>{z.view}</td>
            <td className="zones-mono">{z.ttl}</td>
            <td className="zones-mono">{z.neg_ttl}</td>
            <td className="zones-mono">{z.records}</td>
            <td>
              {z.issues.length > 0 ? (
                <div className="zones-issues">
                  {z.issues.map((issue) => (
                    <span key={issue} className="zones-chip">
                      {issue}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="zones-none">&mdash;</span>
              )}
            </td>
            <td>
              <SeverityBadge severity={z.severity} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
