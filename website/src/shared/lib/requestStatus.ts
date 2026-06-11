import { getSecretRequest } from './api';
import { listStoredRequests } from './requestStore';

// Counts stored requests whose secret has been provided but not yet
// collected. Used for the navbar notification badge.
export async function countFulfilledRequests(): Promise<number> {
  const live = listStoredRequests().filter(
    r => !r.collected && !r.revoked && Date.now() / 1000 < r.expiresAt,
  );
  if (live.length === 0) return 0;
  const states = await Promise.all(
    live.map(async r => {
      const { data } = await getSecretRequest(r.id);
      return data?.state === 'fulfilled' ? 1 : 0;
    }),
  );
  return states.reduce<number>((sum, n) => sum + n, 0);
}
