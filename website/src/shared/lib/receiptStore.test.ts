import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listStoredReceipts,
  recordReceiptState,
  saveStoredReceipt,
  saveNewReceipt,
  type StoredReceipt,
} from './receiptStore';

const receipt: StoredReceipt = {
  id: 'id',
  token: 'token',
  oneTime: true,
  createdAt: 1000,
  expiresAt: 2000,
};

beforeEach(() => localStorage.clear());

describe('receipt storage', () => {
  it('loads receipts created before optional fields existed', () => {
    saveStoredReceipt(receipt);
    expect(listStoredReceipts()).toEqual([receipt]);
  });
  it.each([
    { kind: 'unknown' },
    { state: 'unknown' },
    { viewedAt: 'today' },
    { expiresAt: null },
  ])('filters corrupt metadata: %j', patch => {
    localStorage.setItem(
      'yopass-read-receipts',
      JSON.stringify([receipt, { ...receipt, ...patch }]),
    );
    expect(listStoredReceipts()).toEqual([receipt]);
  });
  it('preserves viewed status across reloads', () => {
    saveStoredReceipt(receipt);
    recordReceiptState(receipt.id, 'viewed', 1500);
    expect(listStoredReceipts()[0]).toMatchObject({
      state: 'viewed',
      viewedAt: 1500,
    });
  });
});

it('keeps successful creation usable when receipt history cannot be saved', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('storage full');
    });
  try {
    expect(() => saveNewReceipt('id', 'token', true, 3600)).not.toThrow();
    expect(listStoredReceipts()).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
});
