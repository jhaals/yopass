import { useTranslation } from 'react-i18next';
import { type StoredRequest } from '@shared/lib/requestStore';
import type { RequestStatus } from './types';

const statusBadge: Record<RequestStatus, string> = {
  loading: 'badge-ghost',
  pending: 'badge-info',
  fulfilled: 'badge-success',
  expired: 'badge-warning',
  revoked: 'badge-error',
  collected: 'badge-neutral',
};

function StatusBadge({ status }: { status: RequestStatus }) {
  const { t } = useTranslation();
  if (status === 'loading') {
    return <span className="loading loading-dots loading-xs" />;
  }
  return (
    <span className={`badge ${statusBadge[status]} badge-sm font-medium`}>
      {t(`request.status.${status}`)}
    </span>
  );
}

interface RequestCardProps {
  request: StoredRequest;
  status: RequestStatus;
  busy: boolean;
  copied: boolean;
  onCopyLink: () => void;
  onViewSecret: () => void;
  onRotateKey: () => void;
  onRevoke: () => void;
  onExport: () => void;
  onRemove: () => void;
}

export default function RequestCard({
  request: r,
  status,
  busy,
  copied,
  onCopyLink,
  onViewSecret,
  onRotateKey,
  onRevoke,
  onExport,
  onRemove,
}: RequestCardProps) {
  const { t } = useTranslation();
  return (
    <div className="p-5 bg-base-200/50 border border-base-300 rounded-lg">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-semibold text-base break-words">
              {r.label || t('request.unnamedRequest')}
            </span>
            <StatusBadge status={status} />
          </div>
          <div className="text-xs text-base-content/60 font-mono">{r.id}</div>
          <div className="text-xs text-base-content/60 mt-1">
            {status === 'pending' || status === 'fulfilled'
              ? t('request.expiresAt', {
                  date: new Date(r.expiresAt * 1000).toLocaleString(),
                })
              : t('request.createdAt', {
                  date: new Date(r.createdAt * 1000).toLocaleString(),
                })}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {status === 'fulfilled' && (
            <button
              className="btn btn-success btn-sm"
              disabled={busy}
              onClick={onViewSecret}
            >
              {busy && <span className="loading loading-spinner loading-xs" />}
              {t('request.buttonViewSecret')}
            </button>
          )}
          {status === 'pending' && (
            <button
              className={`btn btn-sm ${copied ? 'btn-success' : 'btn-primary btn-outline'}`}
              onClick={onCopyLink}
            >
              {copied ? t('common.copied') : t('request.buttonCopyLink')}
            </button>
          )}
          <div className="dropdown dropdown-end">
            <button
              tabIndex={0}
              className="btn btn-ghost btn-sm"
              aria-label={t('request.buttonMore')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
                />
              </svg>
            </button>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-base-100 rounded-box z-10 w-56 p-2 shadow border border-base-300"
            >
              {status === 'pending' && (
                <li>
                  <button onClick={onRotateKey}>
                    {t('request.buttonRotateKey')}
                  </button>
                </li>
              )}
              {(status === 'pending' || status === 'fulfilled') && (
                <li>
                  <button onClick={onRevoke}>
                    {t('request.buttonRevoke')}
                  </button>
                </li>
              )}
              <li>
                <button onClick={onExport}>{t('request.buttonExport')}</button>
              </li>
              <li>
                <button onClick={onRemove}>{t('request.buttonRemove')}</button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
