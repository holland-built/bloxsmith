import type { Severity } from './network';

export interface Incident {
  key: string;
  category: string;
  severity: Severity;
  count: number;
  sample_entities: string[];
  first_detected_at: number;
  message: string;
  entity_type: string;
}

export interface AlertsHealth {
  fresh: boolean;
  last_successful_fetch: number | null;
  age_seconds: number | null;
  stale_after_seconds: number;
}

export type { Severity } from './network';
