import { readStoredList, writeStoredList } from './localStore';

// Local persistence for secret requests created in this browser. The private
// key stays in this browser. The management token is sent only when authorizing
// retrieval, revocation, or key rotation.
// Both are persisted unencrypted in localStorage to survive browser restarts.
// Same-origin scripts and anyone with access to the browser profile can read
// them. This is a client-side trust boundary, not encrypted-at-rest storage.

export interface StoredRequest {
  id: string;
  label?: string;
  privateKey: string;
  publicKey: string;
  fingerprint: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  revoked?: boolean;
  collected?: boolean;
  // Local cache of the terminal fulfilled state, so the navbar and request
  // list can stop polling a request once its secret has been provided.
  fulfilled?: boolean;
}

const STORAGE_KEY = 'yopass-secret-requests';

// Fired on window whenever the stored requests change, so other components
// (e.g. the navbar counter) can refresh without polling localStorage.
export const REQUESTS_CHANGED_EVENT = 'yopass-requests-changed';

export function listStoredRequests(): StoredRequest[] {
  return readStoredList(STORAGE_KEY, isStoredRequest);
}

function persist(requests: StoredRequest[]) {
  writeStoredList(STORAGE_KEY, REQUESTS_CHANGED_EVENT, requests);
}

export function saveStoredRequest(request: StoredRequest) {
  const requests = listStoredRequests().filter(r => r.id !== request.id);
  requests.unshift(request);
  persist(requests);
}

export function updateStoredRequest(id: string, patch: Partial<StoredRequest>) {
  persist(
    listStoredRequests().map(r => (r.id === id ? { ...r, ...patch } : r)),
  );
}

// Caches the fulfilled terminal state for the given requests in a single
// write. Pollers that discover several fulfilled requests in one pass use this
// so only one REQUESTS_CHANGED_EVENT is emitted (and none when nothing
// changed), which keeps the change event from re-entering an in-flight poll.
export function markRequestsFulfilled(ids: string[]) {
  if (ids.length === 0) return;
  const mark = new Set(ids);
  const requests = listStoredRequests();
  if (!requests.some(r => mark.has(r.id) && !r.fulfilled)) return;
  persist(requests.map(r => (mark.has(r.id) ? { ...r, fulfilled: true } : r)));
}

export function removeStoredRequest(id: string) {
  persist(listStoredRequests().filter(r => r.id !== id));
}

// Removes all requests whose secret has already been collected. Local-only:
// collected requests no longer exist on the server.
export function clearCollectedRequests() {
  persist(listStoredRequests().filter(r => !r.collected));
}

// Wipes every stored request, including private keys and tokens.
export function clearAllStoredRequests() {
  persist([]);
}

// Export format for moving a request to another browser. Contains the
// private key and management token — treat the exported file as a secret.
export function exportStoredRequest(request: StoredRequest): string {
  return JSON.stringify({ yopassSecretRequest: 1, ...request }, null, 2);
}

export function importStoredRequest(json: string): StoredRequest {
  const parsed = JSON.parse(json);
  // Preserve compatibility with old exports that contained an invalid cache flag.
  if (
    parsed &&
    typeof parsed === 'object' &&
    typeof parsed.fulfilled !== 'boolean'
  ) {
    delete parsed.fulfilled;
  }
  if (!isStoredRequest(parsed)) {
    throw new Error('invalid request export');
  }
  const request: StoredRequest = {
    id: parsed.id,
    label: parsed.label,
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
    token: parsed.token,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    revoked: parsed.revoked,
    collected: parsed.collected,
    fulfilled:
      typeof parsed.fulfilled === 'boolean' ? parsed.fulfilled : undefined,
  };
  saveStoredRequest(request);
  return request;
}

function isStoredRequest(value: unknown): value is StoredRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    (v.label === undefined || typeof v.label === 'string') &&
    (v.revoked === undefined || typeof v.revoked === 'boolean') &&
    (v.collected === undefined || typeof v.collected === 'boolean') &&
    (v.fulfilled === undefined || typeof v.fulfilled === 'boolean') &&
    typeof v.privateKey === 'string' &&
    typeof v.publicKey === 'string' &&
    typeof v.fingerprint === 'string' &&
    typeof v.token === 'string' &&
    typeof v.createdAt === 'number' &&
    Number.isFinite(v.createdAt) &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt)
  );
}
