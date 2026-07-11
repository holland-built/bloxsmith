import type { Severity } from '../types/network';
import './SeverityBadge.css';

const LABELS: Record<Severity, string> = {
  crit: 'CRIT',
  warn: 'WARN',
  ok: 'OK',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`severity-badge ${severity}`}>{LABELS[severity]}</span>
  );
}
