import { useCallback, useEffect, useState } from 'react';

export interface VaultTenant {
  id: string;
  label: string;
}

export interface VaultStatus {
  vaultMode: boolean;
  exists: boolean;
  unlocked: boolean;
  ready: boolean;
  tenants: VaultTenant[];
  active: string;
}

interface UseVaultStatusResult {
  status: VaultStatus | null;
  loading: boolean;
  refetch: () => void;
}

export function useVaultStatus(): UseVaultStatusResult {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [trigger, setTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/vault/status', { credentials: 'include', signal: controller.signal })
      .then((res) => res.json() as Promise<VaultStatus>)
      .then((json) => setStatus(json))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [trigger]);

  const refetch = useCallback(() => setTrigger((t) => t + 1), []);

  return { status, loading, refetch };
}
