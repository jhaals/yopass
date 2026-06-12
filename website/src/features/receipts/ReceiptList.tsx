import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSecretReceipt } from '@shared/lib/api';
import { formatDateTime } from '@shared/lib/dateFormat';
import { useDateFormat } from '@shared/hooks/useDateFormat';
import {
  clearAllStoredReceipts,
  listStoredReceipts,
  recordReceiptState,
  removeStoredReceipt,
  type StoredReceipt,
} from '@shared/lib/receiptStore';

const POLL_INTERVAL_MS = 15_000;

type ReceiptListStatus = 'loading' | 'pending' | 'viewed' | 'expired';

interface ReceiptDisplay {
  status: ReceiptListStatus;
  viewedAt?: number;
}

const statusBadge: Record<ReceiptListStatus, string> = {
  loading: 'badge-ghost',
  pending: 'badge-info',
  viewed: 'badge-success',
  expired: 'badge-warning',
};

function StatusBadge({ status }: { status: ReceiptListStatus }) {
  const { t } = useTranslation();
  if (status === 'loading') {
    return <span className="loading loading-dots loading-xs" />;
  }
  return (
    <span className={`badge ${statusBadge[status]} badge-sm font-medium`}>
      {t(`receipts.status.${status}`)}
    </span>
  );
}

export default function ReceiptList() {
  const { t } = useTranslation();
  const [dateFormat] = useDateFormat();
  const [receipts, setReceipts] = useState<StoredReceipt[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ReceiptDisplay>>({});
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'clearAll';
    id?: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const stored = listStoredReceipts();
    setReceipts(stored);
    const results = await Promise.all(
      stored.map(async (r): Promise<[string, ReceiptDisplay]> => {
        const { data, status } = await getSecretReceipt(r.id, r.token);
        if (data) {
          // Cache the observed state so "opened at ..." survives the
          // receipt's expiry on the server.
          recordReceiptState(r.id, data.state, data.viewed_at);
          return [r.id, { status: data.state, viewedAt: data.viewed_at }];
        }
        if (status === 404) {
          // The receipt expired on the server. The locally cached state
          // still tells whether the secret was opened in time.
          if (r.state === 'viewed') {
            return [r.id, { status: 'viewed', viewedAt: r.viewedAt }];
          }
          return [r.id, { status: 'expired' }];
        }
        return [r.id, { status: 'loading' }];
      }),
    );
    setStatuses(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  async function runConfirmedAction() {
    if (!confirmAction) return;
    const { type, id } = confirmAction;
    setConfirmAction(null);
    if (type === 'clearAll') {
      clearAllStoredReceipts();
    } else if (id) {
      removeStoredReceipt(id);
    }
    await refresh();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="text-3xl font-bold">{t('receipts.listTitle')}</h2>
        <div className="flex gap-2 flex-wrap">
          {receipts.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmAction({ type: 'clearAll' })}
            >
              {t('receipts.buttonClearAll')}
            </button>
          )}
          <a href="#/" className="btn btn-primary btn-sm">
            {t('receipts.buttonNewSecret')}
          </a>
        </div>
      </div>
      <p className="text-base text-base-content/70 mb-6">
        {t('receipts.listSubtitle')}
      </p>

      {receipts.length === 0 ? (
        <div className="text-center py-12">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1}
            stroke="currentColor"
            className="w-16 h-16 mx-auto text-base-content/30 mb-4"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
            />
          </svg>
          <p className="text-base-content/60 mb-6">{t('receipts.listEmpty')}</p>
          <a href="#/" className="btn btn-primary">
            {t('receipts.buttonNewSecret')}
          </a>
        </div>
      ) : (
        <div className="space-y-4" data-testid="receipt-list">
          {receipts.map(r => {
            const display = statuses[r.id] ?? { status: 'loading' as const };
            return (
              <div
                key={r.id}
                className="p-5 bg-base-200/50 border border-base-300 rounded-lg"
                data-testid="receipt-list-item"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-base">
                        {t('receipts.itemTitle', {
                          date: formatDateTime(r.createdAt, dateFormat),
                        })}
                      </span>
                      {r.kind === 'file' && (
                        <span className="badge badge-ghost badge-sm font-medium">
                          {t('receipts.kindFile')}
                        </span>
                      )}
                      <StatusBadge status={display.status} />
                    </div>
                    <div className="text-xs text-base-content/60 font-mono">
                      {r.id}
                    </div>
                    <div className="text-xs text-base-content/60 mt-1">
                      {display.status === 'viewed' && display.viewedAt
                        ? t('receipts.viewedAt', {
                            date: formatDateTime(display.viewedAt, dateFormat),
                          })
                        : display.status === 'expired'
                          ? t('result.receiptExpired')
                          : t('receipts.expiresAt', {
                              date: formatDateTime(r.expiresAt, dateFormat),
                            })}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setConfirmAction({ type: 'remove', id: r.id })
                    }
                  >
                    {t('receipts.buttonRemove')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmAction && (
        <div className="modal modal-open" role="dialog">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-2">
              {t(`receipts.confirm.${confirmAction.type}Title`)}
            </h3>
            <p className="text-sm text-base-content/70">
              {t(`receipts.confirm.${confirmAction.type}Message`)}
            </p>
            <div className="modal-action">
              <button
                className="btn btn-error btn-sm"
                onClick={runConfirmedAction}
              >
                {t(`receipts.confirm.${confirmAction.type}Confirm`)}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setConfirmAction(null)}
              >
                {t('delete.dialogCancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
