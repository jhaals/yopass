// Local persistence for secret requests created in this browser. The private
// key and management token are only stored here — they are never sent to the
// server.

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
}

const STORAGE_KEY = 'yopass-secret-requests';

// Fired on window whenever the stored requests change, so other components
// (e.g. the navbar counter) can refresh without polling localStorage.
export const REQUESTS_CHANGED_EVENT = 'yopass-requests-changed';

export function listStoredRequests(): StoredRequest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredRequest);
  } catch {
    return [];
  }
}

function persist(requests: StoredRequest[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  window.dispatchEvent(new Event(REQUESTS_CHANGED_EVENT));
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
  };
  saveStoredRequest(request);
  return request;
}

function isStoredRequest(value: unknown): value is StoredRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.privateKey === 'string' &&
    typeof v.publicKey === 'string' &&
    typeof v.fingerprint === 'string' &&
    typeof v.token === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.expiresAt === 'number'
  );
}
