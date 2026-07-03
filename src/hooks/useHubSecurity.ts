import { useEffect, useState } from 'react';
import type { SecurityFeed } from '../types/hub';

interface UseHubSecurityResult {
  data: SecurityFeed | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Real DNS security (threat) events + severity/action counts from
 *  /api/hub/security (Infoblox DNSEvents, last hour). */
export function useHubSecurity(): UseHubSecurityResult {
  const [data, setData] = useState<SecurityFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/hub/security?limit=50', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<SecurityFeed>;
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
