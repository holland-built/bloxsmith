import { useEffect, useState } from 'react';
import type { McpEvent } from '../types/mcp';

interface UseMcpEventsResult {
  data: McpEvent[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useMcpEvents(): UseMcpEventsResult {
  const [data, setData] = useState<McpEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/mcp/events?limit=50', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<McpEvent[]>;
      })
      .then((json) => {
        setData(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [trigger]);

  const refetch = () => setTrigger((t) => t + 1);

  return { data, loading, error, refetch };
}
