import { useEffect, useRef, useState } from 'react';
import { getSecret, isVerificationRequired } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';

// Fetches (and for one-time secrets, consumes) an encrypted text secret once
// `enabled` turns true. Fetches at most once per key/token pair, which also
// guards against duplicate calls under React StrictMode; if `key` changes while
// mounted the new secret is fetched and stale state is cleared.
//
// `verificationToken` is supplied once the recipient has passed verification.
// Because it is part of the fetch identity, obtaining a token re-runs the
// fetch that was previously refused.
export default function useFetchSecret(
  key: string,
  enabled: boolean,
  verificationToken?: string,
) {
  const { OIDC_ENABLED } = useConfig();
  const fetchedKeyRef = useRef<string | null>(null);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [requiresVerification, setRequiresVerification] = useState(false);

  useEffect(() => {
    const fetchID = `${key}:${verificationToken ?? ''}`;
    if (!enabled || fetchedKeyRef.current === fetchID) {
      return;
    }
    fetchedKeyRef.current = fetchID;
    setLoading(true);
    setError(null);
    setSecret(undefined);
    setRequiresAuth(false);
    setRequiresVerification(false);
    (async () => {
      try {
        const result = await getSecret(key, OIDC_ENABLED, verificationToken);
        const { data, status } = result;
        // Drop a superseded response if `key` changed while it was in flight.
        // Comparing against the ref (rather than an effect-cleanup flag) keeps
        // the once-per-key StrictMode guard intact.
        if (fetchedKeyRef.current !== fetchID) {
          return;
        }
        if (status === 401) {
          setRequiresAuth(true);
          return;
        }
        if (isVerificationRequired(result)) {
          setRequiresVerification(true);
          return;
        }
        if (!data || typeof data.message !== 'string') {
          throw new Error('Failed to fetch secret');
        }
        setSecret(data.message);
      } catch (e) {
        if (fetchedKeyRef.current === fetchID) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      } finally {
        if (fetchedKeyRef.current === fetchID) {
          setLoading(false);
        }
      }
    })();
  }, [enabled, key, OIDC_ENABLED, verificationToken]);

  return { secret, loading, error, requiresAuth, requiresVerification };
}
