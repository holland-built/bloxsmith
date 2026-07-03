import { useEffect, useState } from 'react';
import type { HubDomains } from '../types/domains';

interface UseHubDomainsResult {
  data: HubDomains | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Rich cross-platform domain panels from /api/hub/domains (direct REST). */
export function useHubDomains(): UseHubDomainsResult {
  const [data, setData] = useState<HubDomains | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/hub/domains', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<HubDomains>;
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
