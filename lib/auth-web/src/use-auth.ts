import { useCallback, useEffect, useState } from 'react';
import type { AuthUser } from '@workspace/api-client-react';
export type { AuthUser };

async function authRequest(path: string, body: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Authentication request failed.');
  return data;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/user', { credentials: 'include', signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error('Unable to reach the sign-in service.');
        return res.json();
      }).then(data => setUser(data.user ?? null))
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false); });
    return () => controller.abort();
  }, []);
  const login = useCallback(async (email: string, password: string) => {
    const data = await authRequest('login', { email: email.trim().toLowerCase(), password });
    setError('');
    setUser(data.user);
  }, []);
  const logout = useCallback(async () => {
    try { await authRequest('logout', {}); window.location.reload(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Logout failed.'); }
  }, []);
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await authRequest('change-password', { currentPassword, newPassword });
    window.location.reload();
  }, []);
  return { user, isLoading, isAuthenticated: !!user, error, login, logout, changePassword };
}
