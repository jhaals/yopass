import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSecretReceipt } from '@shared/lib/api';
import type { ReceiptStatus as ReceiptStatusData } from '@shared/lib/api';
import { formatDateTime } from '@shared/lib/dateFormat';
import { useDateFormat } from '@shared/hooks/useDateFormat';
import { recordReceiptState } from '@shared/lib/receiptStore';
import { CheckIcon, RefreshIcon } from '@shared/components/icons';

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
    // Both viewed and expired are terminal: don't schedule any refresh once
    // either holds, so no extra request fires after reaching that state.
    if (viewed || expired) return;
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh, viewed, expired]);

  let statusContent: React.ReactNode;
  if (viewed) {
    statusContent = (
      <span
        className="inline-flex items-center gap-2 text-success font-medium"
        data-testid="receipt-status-viewed"
      >
        <CheckIcon className="size-5" />
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
            <RefreshIcon className="size-4" />
            {t('result.receiptRefresh')}
          </button>
        )}
      </div>
    </div>
  );
}
