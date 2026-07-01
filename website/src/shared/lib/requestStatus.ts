import { getSecretRequest } from './api';
import { listStoredRequests, updateStoredRequest } from './requestStore';

// Counts stored requests whose secret has been provided but not yet
// collected. Used for the navbar notification badge. Requests already known
// to be fulfilled are counted from the local cache, so only still-pending
// requests trigger a server lookup.
export async function countFulfilledRequests(): Promise<number> {
  const live = listStoredRequests().filter(
    r => !r.collected && !r.revoked && Date.now() / 1000 < r.expiresAt,
  );
  const knownFulfilled = live.filter(r => r.fulfilled).length;
  const pending = live.filter(r => !r.fulfilled);
  if (pending.length === 0) return knownFulfilled;
  const states = await Promise.all(
    pending.map(async r => {
      const { data } = await getSecretRequest(r.id);
      if (data?.state === 'fulfilled') {
        updateStoredRequest(r.id, { fulfilled: true });
        return 1;
      }
      return 0;
    }),
  );
  return knownFulfilled + states.reduce<number>((sum, n) => sum + n, 0);
}
