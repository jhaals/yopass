import { useEffect, useRef, useState } from 'react';
import { getSecret } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';

// Fetches (and for one-time secrets, consumes) an encrypted text secret once
// `enabled` turns true. Fetches at most once for the component's lifetime,
// which also guards against duplicate calls under React StrictMode.
export default function useFetchSecret(key: string, enabled: boolean) {
  const { OIDC_ENABLED } = useConfig();
  const hasFetchedRef = useRef(false);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);

  useEffect(() => {
    if (!enabled || hasFetchedRef.current) {
      return;
    }
    hasFetchedRef.current = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const { data, status } = await getSecret(key, OIDC_ENABLED);
        if (status === 401) {
          setRequiresAuth(true);
          return;
        }
        if (!data || typeof data.message !== 'string') {
          throw new Error('Failed to fetch secret');
        }
        setSecret(data.message);
      } catch (e) {
        setError(e as Error);
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled, key, OIDC_ENABLED]);

  return { secret, loading, error, requiresAuth };
}
