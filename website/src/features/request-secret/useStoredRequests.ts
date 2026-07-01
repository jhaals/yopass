import { useCallback, useEffect, useRef, useState } from 'react';
import { getSecretRequest } from '@shared/lib/api';
import {
  listStoredRequests,
  updateStoredRequest,
  REQUESTS_CHANGED_EVENT,
  type StoredRequest,
} from '@shared/lib/requestStore';
import type { RequestStatus } from './types';

// Owns the locally stored requests and their server-side status. Re-resolves
// statuses on mount and whenever the store changes (including from other
// components such as the navbar badge), so the list stays in sync without
// manual polling.
export function useStoredRequests() {
  const [requests, setRequests] = useState<StoredRequest[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RequestStatus>>({});
  const refreshGen = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++refreshGen.current;
    const stored = listStoredRequests();
    setRequests(stored);
    const results = await Promise.all(
      stored.map(async (r): Promise<[string, RequestStatus]> => {
        if (r.collected) return [r.id, 'collected'];
        if (r.revoked) return [r.id, 'revoked'];
        // Terminal states are resolved locally, without a server lookup.
        // Expiry wins over a cached fulfilled state: once the TTL passes the
        // server has deleted the secret, so it can no longer be collected.
        if (Date.now() / 1000 > r.expiresAt) return [r.id, 'expired'];
        if (r.fulfilled) return [r.id, 'fulfilled'];
        const { data, status } = await getSecretRequest(r.id);
        if (data) {
          if (data.state === 'fulfilled') {
            updateStoredRequest(r.id, { fulfilled: true });
          }
          return [r.id, data.state];
        }
        if (status === 404) {
          const expired = Date.now() / 1000 > r.expiresAt;
          return [r.id, expired ? 'expired' : 'revoked'];
        }
        return [r.id, 'loading'];
      }),
    );
    if (gen === refreshGen.current) {
      setStatuses(Object.fromEntries(results));
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: read the local store and render the list immediately,
    // then resolve server-side statuses asynchronously. The synchronous
    // setState inside refresh is the intended initial load, not a render
    // cascade, so the set-state-in-effect heuristic does not apply here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(REQUESTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(REQUESTS_CHANGED_EVENT, refresh);
  }, [refresh]);

  return { requests, statuses, refresh };
}
