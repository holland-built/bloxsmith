import { useMcpIncidents } from '../hooks/useMcpIncidents';
import { useMcpEvents } from '../hooks/useMcpEvents';
import type { McpIncident } from '../types/mcp';
import './NocStatusBar.css';

interface NocStatusBarProps {
  isAdmin?: boolean;
  onManageVault?: () => void;
  onLogout?: () => void;
}

export function NocStatusBar({ isAdmin, onManageVault, onLogout }: NocStatusBarProps) {
  // Use the same hooks — 30s TTL cache means no extra requests
  const { data: incidents, loading: incLoading, error: incError } = useMcpIncidents();
  const { data: events } = useMcpEvents();

  const crit = incidents?.filter((i: McpIncident) => i.severity === 'crit').length ?? 0;
  const warn = incidents?.filter((i: McpIncident) => i.severity === 'warn').length ?? 0;
  const ok   = incidents?.filter((i: McpIncident) => i.severity === 'ok').length ?? 0;
  const total = incidents?.length ?? 0;
  const eventCount = events?.length ?? 0;
  const mcpOk = !incError && !incLoading;

  return (
    <header className="noc-status-bar">
      <div className="noc-bar-brand">Infoblox NOC</div>
      <div className="noc-bar-kpis">
        <span className="noc-kpi noc-kpi--total" title="Total open incidents">{total} Open</span>
        <span className="noc-kpi noc-kpi--crit" title="Critical">{crit} Crit</span>
        <span className="noc-kpi noc-kpi--warn" title="Warning">{warn} Warn</span>
        <span className="noc-kpi noc-kpi--ok" title="OK / informational">{ok} OK</span>
        <span className="noc-kpi-divider" />
        <span className="noc-kpi noc-kpi--events" title="Events in feed">{eventCount} Events</span>
      </div>
      <div className="noc-bar-right">
        <span className={`noc-mcp-indicator ${mcpOk ? 'noc-mcp-ok' : 'noc-mcp-err'}`} title={mcpOk ? 'MCP connected' : 'MCP error'}>
          ● MCP
        </span>
        {isAdmin && onManageVault && (
          <button type="button" className="noc-bar-btn" onClick={onManageVault}>Vault</button>
        )}
        {onLogout && (
          <button type="button" className="noc-bar-btn" onClick={onLogout}>Logout</button>
        )}
      </div>
    </header>
  );
}
