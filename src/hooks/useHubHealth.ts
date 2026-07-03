import { useEffect, useState } from 'react';
import type { ServiceHealth } from '../types/hub';

interface UseHubHealthResult {
  data: ServiceHealth[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Real per-service health (DNS/DHCP/Security) from /api/hub/health.
 *  IPAM is not returned here — the hub derives it from subnet utilization. */
export function useHubHealth(): UseHubHealthResult {
  const [data, setData] = useState<ServiceHealth[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/hub/health', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<ServiceHealth[]>;
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
