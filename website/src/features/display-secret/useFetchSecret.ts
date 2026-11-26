import { useEffect, useRef, useState } from 'react';
import { getSecret, isRecipientRefusal } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';

// Fetches (and for one-time secrets, consumes) an encrypted text secret once
// `enabled` turns true. Fetches at most once per key, which also guards against
// duplicate calls under React StrictMode; if `key` changes while mounted the
// new secret is fetched and stale state is cleared.
// Bumping `attempt` fetches again, after an emailed code granted access.
export default function useFetchSecret(
  key: string,
  enabled: boolean,
  attempt = 0,
) {
  const { OIDC_ENABLED } = useConfig();
  const fetchedKeyRef = useRef<string | null>(null);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [notRecipient, setNotRecipient] = useState(false);
  // The refusal said the secret is for one recipient.
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    const fetchKey = `${key}#${attempt}`;
    if (!enabled || fetchedKeyRef.current === fetchKey) {
      return;
    }
    fetchedKeyRef.current = fetchKey;
    setLoading(true);
    setError(null);
    setSecret(undefined);
    setRequiresAuth(false);
    setNotRecipient(false);
    setRestricted(false);
    (async () => {
      try {
        const result = await getSecret(key, OIDC_ENABLED);
        const { data, status } = result;
        // Drop a superseded response if `key` changed while it was in flight.
        // Comparing against the ref (rather than an effect-cleanup flag) keeps
        // the once-per-key StrictMode guard intact.
        if (fetchedKeyRef.current !== fetchKey) {
          return;
        }
        setRestricted(isRecipientRefusal(result));
        if (status === 401) {
          setRequiresAuth(true);
          return;
        }
        // Signed in, but restricted to someone else. Nothing was consumed.
        if (status === 403) {
          setNotRecipient(true);
          return;
        }
        if (!data || typeof data.message !== 'string') {
          throw new Error('Failed to fetch secret');
        }
        setSecret(data.message);
      } catch (e) {
        if (fetchedKeyRef.current === fetchKey) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (fetchedKeyRef.current === fetchKey) {
          setLoading(false);
        }
      }
    })();
  }, [enabled, key, attempt, OIDC_ENABLED]);

  return { secret, loading, error, requiresAuth, notRecipient, restricted };
}
