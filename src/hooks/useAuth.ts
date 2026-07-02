import { useCallback, useEffect, useState } from 'react';

interface AuthUser {
  email: string;
  role: string;
}

interface UseAuthResult {
  user: AuthUser | null;
  loading: boolean;
  devLogin: (email: string, role: string) => Promise<void>;
  logout: () => Promise<void>;
}

export function useAuth(): UseAuthResult {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      if (res.ok) {
        setUser((await res.json()) as AuthUser);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const devLogin = useCallback(
    async (email: string, role: string) => {
      const res = await fetch('/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      if (res.ok) {
        await refresh();
      }
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setUser(null);
  }, []);

  return { user, loading, devLogin, logout };
}
