export interface McpIncident {
  id: string;
  display_id?: string;
  type: string;
  title: string;
  priority: 'low' | 'medium' | 'high';
  severity: 'ok' | 'warn' | 'crit';
  status: string;
  affected: number;
  last_activity: string;
}

export interface McpIncidentDetail extends McpIncident {
  description: string;
  triggers: { event_time: string; description: string }[];
}

export interface McpEvent {
  account_id: string;
  event_timestamp: string;
  event_type: string;
  ophid: string;
  description: string;
}
