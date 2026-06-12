// Local persistence for read receipts of secrets created in this browser.
// Only the receipt token and metadata are stored — never the secret link or
// decryption key, so the store cannot be used to retrieve a secret.

export interface StoredReceipt {
  id: string;
  token: string;
  oneTime: boolean;
  // What the receipt belongs to; absent in records stored before file
  // receipts existed, which are all text secrets.
  kind?: 'secret' | 'file';
  createdAt: number;
  expiresAt: number;
  // Last state observed from the server. Receipts disappear from the server
  // when the secret's lifetime ends; caching the viewed state here lets the
  // list keep showing "opened at ..." after expiry.
  state?: 'pending' | 'viewed';
  viewedAt?: number;
}

const STORAGE_KEY = 'yopass-read-receipts';

// Fired on window whenever the stored receipts change, so other components
// can refresh without polling localStorage.
export const RECEIPTS_CHANGED_EVENT = 'yopass-receipts-changed';

export function listStoredReceipts(): StoredReceipt[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredReceipt);
  } catch {
    return [];
  }
}

function persist(receipts: StoredReceipt[]) {
  // lgtm[js/clear-text-storage-of-sensitive-data] — token is a receipt check token, not the secret or decryption key
  localStorage.setItem(STORAGE_KEY, JSON.stringify(receipts));
  window.dispatchEvent(new Event(RECEIPTS_CHANGED_EVENT));
}

export function saveStoredReceipt(receipt: StoredReceipt) {
  const receipts = listStoredReceipts().filter(r => r.id !== receipt.id);
  receipts.unshift(receipt);
  persist(receipts);
}

// Stores a receipt for a secret or file created just now with the given
// lifetime.
export function saveNewReceipt(
  id: string,
  token: string,
  oneTime: boolean,
  expirationSeconds: number,
  kind: 'secret' | 'file' = 'secret',
) {
  const now = Math.floor(Date.now() / 1000);
  saveStoredReceipt({
    id,
    token,
    oneTime,
    kind,
    createdAt: now,
    expiresAt: now + expirationSeconds,
  });
}

// Caches the last server-observed state on the stored receipt.
export function recordReceiptState(
  id: string,
  state: 'pending' | 'viewed',
  viewedAt?: number,
) {
  const receipts = listStoredReceipts();
  const receipt = receipts.find(r => r.id === id);
  if (!receipt || (receipt.state === state && receipt.viewedAt === viewedAt)) {
    return;
  }
  persist(receipts.map(r => (r.id === id ? { ...r, state, viewedAt } : r)));
}

export function removeStoredReceipt(id: string) {
  persist(listStoredReceipts().filter(r => r.id !== id));
}

export function clearAllStoredReceipts() {
  persist([]);
}

function isStoredReceipt(value: unknown): value is StoredReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.token === 'string' &&
    typeof v.oneTime === 'boolean' &&
    typeof v.createdAt === 'number' &&
    typeof v.expiresAt === 'number'
  );
}
