import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { getSecretReceipt } from '@shared/lib/api';
import { saveStoredReceipt } from '@shared/lib/receiptStore';
import en from '@shared/locales/en.json';
import ReceiptStatus from '../display-secret/ReceiptStatus';
import ReceiptList from './ReceiptList';

vi.mock('@shared/lib/api', () => ({ getSecretReceipt: vi.fn() }));
vi.mock('@shared/hooks/useDateFormat', () => ({
  useDateFormat: () => ['iso'],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'result.receiptExpired' ? en.result.receiptExpired : key,
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

it.each(['list 404', 'list past deadline', 'result 404'])(
  '%s never claims a secret was unopened',
  async mode => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.mocked(getSecretReceipt)
      .mockReset()
      .mockResolvedValue({ status: 404, data: null });
    saveStoredReceipt({
      id: 'id',
      token: 'token',
      oneTime: true,
      createdAt: Date.now() / 1000 - 100,
      expiresAt:
        Date.now() / 1000 + (mode === 'list past deadline' ? -1 : 3600),
      state: 'pending',
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          mode.startsWith('list') ? (
            <ReceiptList />
          ) : (
            <ReceiptStatus uuid="id" token="token" />
          ),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(container.textContent).toContain(en.result.receiptExpired);
      expect(en.result.receiptExpired).toContain('can no longer be checked');
      if (mode === 'list past deadline')
        expect(getSecretReceipt).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
