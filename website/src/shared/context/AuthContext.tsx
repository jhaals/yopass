import React, { useEffect, useState } from 'react';
import { useConfig } from '@shared/hooks/useConfig';
import { backendDomain } from '@shared/lib/api';
import { AuthContext, AuthState } from './authContext';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { OIDC_ENABLED } = useConfig();
  const [state, setState] = useState<AuthState>(() => ({
    loading: OIDC_ENABLED,
    isAuthenticated: false,
  }));

  useEffect(() => {
    if (!OIDC_ENABLED) return;
    const controller = new AbortController();
    fetch(`${backendDomain}/auth/me`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(r => {
        if (r.status === 200)
          setState({ loading: false, isAuthenticated: true });
        else if (r.status === 401)
          setState({ loading: false, isAuthenticated: false });
        else throw new Error(`Unexpected /auth/me status: ${r.status}`);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setState({ loading: false, isAuthenticated: false });
      });
    return () => controller.abort();
  }, [OIDC_ENABLED]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
