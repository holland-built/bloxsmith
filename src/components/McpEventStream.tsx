import { useEffect } from 'react';
import { useMcpEvents } from '../hooks/useMcpEvents';
import { DegradedState } from './DegradedState';
import './McpEventStream.css';

const AUTO_REFRESH_MS = 30_000;

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      ' ' + d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' });
  } catch {
    return iso;
  }
}

export function McpEventStream() {
  const { data, loading, error, refetch } = useMcpEvents();

  // Auto-refresh every 30s
  useEffect(() => {
    const id = window.setInterval(refetch, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  return (
    <section className="mcp-event-stream">
      <div className="mcp-section-header">
        <h2 className="mcp-section-title">Event Stream</h2>
        <button type="button" className="mcp-refresh-btn" onClick={refetch} aria-label="Refresh events">
          ↻
        </button>
      </div>

      {loading && <DegradedState mode="loading" />}
      {!loading && error && <DegradedState mode="error" onRetry={refetch} />}
      {!loading && !error && data && data.length === 0 && (
        <p className="mcp-empty">No events</p>
      )}
      {!loading && !error && data && data.length > 0 && (
        <div className="mcp-event-scroll">
          <ul className="mcp-event-list">
            {data.map((event, i) => (
              <li key={`${event.ophid}-${i}`} className="mcp-event-row">
                <span className="mcp-event-ts">{formatTimestamp(event.event_timestamp)}</span>
                <span className={`mcp-event-type-badge mcp-event-type-${event.event_type.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}>
                  {event.event_type}
                </span>
                <span className="mcp-event-desc">{event.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
