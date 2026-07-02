import { getSecretRequest } from './api';
import { listStoredRequests, markRequestsFulfilled } from './requestStore';

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
  const results = await Promise.all(
    pending.map(async r => {
      const { data } = await getSecretRequest(r.id);
      return data?.state === 'fulfilled' ? r.id : null;
    }),
  );
  const nowFulfilled = results.filter((id): id is string => id !== null);
  // Cache the newly observed fulfilled states in a single write, after every
  // lookup has resolved, so the change event can't re-enter this poll mid-call.
  markRequestsFulfilled(nowFulfilled);
  return knownFulfilled + nowFulfilled.length;
}
