import { useIncidents } from '../hooks/useIncidents';
import { drillTo } from '../lib/drilldown';
import { DegradedState } from './DegradedState';
import { SeverityBadge } from './SeverityBadge';
import { SnoozeControl } from './SnoozeControl';
import './TriagePanel.css';

export function TriagePanel() {
  const { data, loading, error, refetch } = useIncidents();

  if (loading) return <DegradedState mode="loading" />;
  if (error) return <DegradedState mode="error" />;

  if (!data || data.length === 0) {
    return (
      <section className="triage-panel">
        <h2>Triage</h2>
        <p className="triage-empty">
          No issues detected — all metrics within normal thresholds
        </p>
      </section>
    );
  }

  return (
    <section className="triage-panel">
      <h2>Triage</h2>
      <ul className="triage-list">
        {data.map((incident) => (
          <li key={incident.key} className="triage-row">
            <SeverityBadge severity={incident.severity} />
            <span className="triage-count">{incident.count}</span>
            <span className="triage-message">{incident.message}</span>
            <span className="triage-entities">
              {incident.sample_entities.join(', ')}
            </span>
            <button
              type="button"
              className="triage-view"
              onClick={() => drillTo(incident.entity_type, incident.sample_entities[0])}
            >
              View →
            </button>
            <SnoozeControl category={incident.category} onSnoozed={refetch} />
          </li>
        ))}
      </ul>
    </section>
  );
}
