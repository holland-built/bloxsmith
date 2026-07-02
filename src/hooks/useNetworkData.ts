import { useEffect, useState } from 'react';
import type { NetworkData } from '../types/network';

interface UseNetworkDataResult {
  data: NetworkData | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useNetworkData(): UseNetworkDataResult {
  const [data, setData] = useState<NetworkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/verticals/network', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json() as Promise<NetworkData>;
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
