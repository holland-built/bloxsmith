import { useEffect, useState } from 'react';
import type { Incident } from '../types/alerts';

interface UseIncidentsResult {
  data: Incident[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useIncidents(): UseIncidentsResult {
  const [data, setData] = useState<Incident[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/alerts/incidents', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<Incident[]>;
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
