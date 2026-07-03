import { useEffect, useState } from 'react';
import { useMcpIncidents } from '../hooks/useMcpIncidents';
import { SeverityBadge } from './SeverityBadge';
import { DegradedState } from './DegradedState';
import type { McpIncident, McpIncidentDetail } from '../types/mcp';
import './McpIncidentQueue.css';

const SEVERITY_ORDER: Record<McpIncident['severity'], number> = {
  crit: 0,
  warn: 1,
  ok: 2,
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`mcp-status-badge mcp-status-${status.toLowerCase()}`}>
      {status}
    </span>
  );
}

function IncidentDetail({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<McpIncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/mcp/incidents/${incidentId}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<McpIncidentDetail>;
      })
      .then((json) => {
        setDetail(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [incidentId]);

  return (
    <div className="mcp-incident-detail">
      <div className="mcp-detail-header">
        <span className="mcp-detail-title">Incident Detail</span>
        <button type="button" className="mcp-detail-close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </div>
      {loading && <DegradedState mode="loading" />}
      {!loading && error && <DegradedState mode="error" />}
      {!loading && detail && (
        <>
          <p className="mcp-detail-description">{detail.description}</p>
          {detail.triggers.length > 0 && (
            <div className="mcp-triggers">
              <h4 className="mcp-triggers-heading">Triggers</h4>
              <ul className="mcp-triggers-list">
                {detail.triggers.map((t, i) => (
                  <li key={i} className="mcp-trigger-row">
                    <span className="mcp-trigger-time">{new Date(t.event_time).toLocaleString()}</span>
                    <span className="mcp-trigger-desc">{t.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function McpIncidentQueue() {
  const { data, loading, error, refetch } = useMcpIncidents();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = data
    ? [...data].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    : null;

  return (
    <section className="mcp-incident-queue">
      <div className="mcp-section-header">
        <h2 className="mcp-section-title">Active Anomalies</h2>
        <button type="button" className="mcp-refresh-btn" onClick={refetch} aria-label="Refresh incidents">
          ↻
        </button>
      </div>

      {loading && <DegradedState mode="loading" />}
      {!loading && error && <DegradedState mode="error" onRetry={refetch} />}
      {!loading && !error && sorted && sorted.length === 0 && (
        <p className="mcp-empty">No active incidents</p>
      )}
      {!loading && !error && sorted && sorted.length > 0 && (
        <div className="mcp-incident-list-wrap">
        <ul className="mcp-incident-list">
          {sorted.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                className={`mcp-incident-row${expandedId === incident.id ? ' mcp-incident-row--expanded' : ''}`}
                onClick={() => setExpandedId(expandedId === incident.id ? null : incident.id)}
                aria-expanded={expandedId === incident.id}
              >
                <SeverityBadge severity={incident.severity} />
                <span className="mcp-incident-id">{incident.display_id ?? incident.id}</span>
                <span className="mcp-incident-type">{incident.type}</span>
                <span className="mcp-incident-title">{incident.title}</span>
                <StatusBadge status={incident.status} />
                <span className="mcp-incident-affected" title="Affected hosts">{incident.affected}</span>
                <span className="mcp-incident-time">{relativeTime(incident.last_activity)}</span>
              </button>
              {expandedId === incident.id && (
                <IncidentDetail
                  incidentId={incident.id}
                  onClose={() => setExpandedId(null)}
                />
              )}
            </li>
          ))}
        </ul>
        </div>
      )}
    </section>
  );
}
