import { readStoredList, writeStoredList } from './localStore';

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
  return readStoredList(STORAGE_KEY, isStoredReceipt);
}

function persist(receipts: StoredReceipt[]) {
  writeStoredList(STORAGE_KEY, RECEIPTS_CHANGED_EVENT, receipts);
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
  try {
    saveStoredReceipt({
      id,
      token,
      oneTime,
      kind,
      createdAt: now,
      expiresAt: now + expirationSeconds,
    });
  } catch (error) {
    // The secret already exists. Keep its link and live receipt available even
    // if this browser cannot persist the optional receipt history.
    console.error('Unable to save receipt history:', error);
  }
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
    (v.kind === undefined || v.kind === 'secret' || v.kind === 'file') &&
    (v.state === undefined || v.state === 'pending' || v.state === 'viewed') &&
    (v.viewedAt === undefined ||
      (typeof v.viewedAt === 'number' && Number.isFinite(v.viewedAt))) &&
    typeof v.token === 'string' &&
    typeof v.oneTime === 'boolean' &&
    typeof v.createdAt === 'number' &&
    Number.isFinite(v.createdAt) &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt)
  );
}
