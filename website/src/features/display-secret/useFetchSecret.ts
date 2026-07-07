import { useEffect, useRef, useState } from 'react';
import { getSecret } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';

// Fetches (and for one-time secrets, consumes) an encrypted text secret once
// `enabled` turns true. Fetches at most once per key, which also guards against
// duplicate calls under React StrictMode; if `key` changes while mounted the
// new secret is fetched and stale state is cleared.
export default function useFetchSecret(key: string, enabled: boolean) {
  const { OIDC_ENABLED } = useConfig();
  const fetchedKeyRef = useRef<string | null>(null);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);

  useEffect(() => {
    if (!enabled || fetchedKeyRef.current === key) {
      return;
    }
    fetchedKeyRef.current = key;
    setLoading(true);
    setError(null);
    setSecret(undefined);
    setRequiresAuth(false);
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
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled, key, OIDC_ENABLED]);

  return { secret, loading, error, requiresAuth };
}
