import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSecretReceipt } from '@shared/lib/api';
import type { ReceiptStatus as ReceiptStatusData } from '@shared/lib/api';
import { formatDateTime } from '@shared/lib/dateFormat';
import { useDateFormat } from '@shared/hooks/useDateFormat';
import { recordReceiptState } from '@shared/lib/receiptStore';

const POLL_INTERVAL_MS = 10_000;

interface ReceiptStatusProps {
  uuid: string;
  token: string;
}

/**
 * Live read receipt panel shown on the result page. Polls the receipt
 * endpoint until the secret has been opened or the receipt expires.
 */
export default function ReceiptStatus({ uuid, token }: ReceiptStatusProps) {
  const { t } = useTranslation();
  const [dateFormat] = useDateFormat();
  const [receipt, setReceipt] = useState<ReceiptStatusData | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    const { data, status } = await getSecretReceipt(uuid, token);
    if (status === 200 && data) {
      setReceipt(data);
      setExpired(false);
      setError(false);
      // Keep the locally stored receipt's cached state in sync so the
      // Receipts page shows the viewed time even after expiry.
      recordReceiptState(uuid, data.state, data.viewed_at);
    } else if (status === 404) {
      // The receipt shares the secret's TTL: 404 after creation means the
      // secret expired before it was opened.
      setExpired(true);
      setError(false);
    } else {
      setError(true);
    }
  }, [uuid, token]);

  const viewed = receipt?.state === 'viewed';

  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    if (viewed) {
      return () => clearTimeout(initial);
    }
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh, viewed]);

  let statusContent: React.ReactNode;
  if (viewed) {
    statusContent = (
      <span
        className="inline-flex items-center gap-2 text-success font-medium"
        data-testid="receipt-status-viewed"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="2"
          stroke="currentColor"
          className="size-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m4.5 12.75 6 6 9-13.5"
          />
        </svg>
        {t('result.receiptViewed', {
          time: formatDateTime(receipt?.viewed_at ?? 0, dateFormat),
        })}
      </span>
    );
  } else if (expired) {
    statusContent = (
      <span
        className="text-base-content/70"
        data-testid="receipt-status-expired"
      >
        {t('result.receiptExpired')}
      </span>
    );
  } else if (error) {
    statusContent = (
      <span className="text-error" data-testid="receipt-status-error">
        {t('result.receiptError')}
      </span>
    );
  } else {
    statusContent = (
      <span
        className="inline-flex items-center gap-2 text-base-content/70"
        data-testid="receipt-status-pending"
      >
        <span className="loading loading-ring loading-sm" aria-hidden="true" />
        {t('result.receiptPending')}
      </span>
    );
  }

  return (
    <div className="mb-4 p-5 bg-base-200/50 border border-base-300 rounded-lg">
      <div className="font-semibold text-base mb-1 text-base-content">
        {t('result.receiptTitle')}
      </div>
      <div className="text-sm text-base-content/70 mb-4">
        {t('result.receiptDescription')}{' '}
        <a href="#/receipts" className="link link-primary">
          {t('result.receiptListHint')}
        </a>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">{statusContent}</div>
        {!viewed && !expired && (
          <button
            type="button"
            className="btn btn-sm btn-ghost font-medium shrink-0"
            onClick={refresh}
            data-testid="receipt-refresh"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              className="size-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
              />
            </svg>
            {t('result.receiptRefresh')}
          </button>
        )}
      </div>
    </div>
  );
}
