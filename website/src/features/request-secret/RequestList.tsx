import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import {
  fetchRequestSecret,
  getSecretRequest,
  revokeSecretRequest,
  rotateRequestKey,
} from '@shared/lib/api';
import {
  decryptWithPrivateKey,
  generateRequestKeyPair,
} from '@shared/lib/crypto';
import {
  clearAllStoredRequests,
  clearCollectedRequests,
  exportStoredRequest,
  importStoredRequest,
  listStoredRequests,
  removeStoredRequest,
  updateStoredRequest,
  type StoredRequest,
} from '@shared/lib/requestStore';
import { requestLink, shortFingerprint } from './requestLink';

type RequestStatus =
  | 'loading'
  | 'pending'
  | 'fulfilled'
  | 'expired'
  | 'revoked'
  | 'collected';

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

export default function RequestList() {
  const { t } = useTranslation();
  const config = useConfig();
  const [requests, setRequests] = useState<StoredRequest[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RequestStatus>>({});
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [revealed, setRevealed] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    type: 'revoke' | 'rotate' | 'remove' | 'clearCollected' | 'purgeAll';
    id?: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    const stored = listStoredRequests();
    setRequests(stored);
    const results = await Promise.all(
      stored.map(async (r): Promise<[string, RequestStatus]> => {
        if (r.collected) return [r.id, 'collected'];
        if (r.revoked) return [r.id, 'revoked'];
        const { data, status } = await getSecretRequest(r.id);
        if (data) return [r.id, data.state];
        if (status === 404) {
          const expired = Date.now() / 1000 > r.expiresAt;
          return [r.id, expired ? 'expired' : 'revoked'];
        }
        return [r.id, 'loading'];
      }),
    );
    setStatuses(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function copyLink(r: StoredRequest) {
    try {
      await navigator.clipboard.writeText(
        requestLink(config.PUBLIC_URL, r.id, shortFingerprint(r.fingerprint)),
      );
      setCopiedId(r.id);
      setTimeout(() => setCopiedId(''), 1500);
    } catch {
      // noop
    }
  }

  async function viewSecret(r: StoredRequest) {
    setError('');
    setBusyId(r.id);
    try {
      const { data, message } = await fetchRequestSecret(r.id, r.token);
      if (!data) {
        setError(message || t('request.errorFetchFailed'));
        return;
      }
      const secret = await decryptWithPrivateKey(data.message, r.privateKey);
      updateStoredRequest(r.id, { collected: true });
      setRevealed({ id: r.id, secret });
      await refresh();
    } catch {
      setError(t('request.errorDecryptFailed'));
    } finally {
      setBusyId('');
    }
  }

  async function revoke(r: StoredRequest) {
    setError('');
    setBusyId(r.id);
    try {
      const { status, message } = await revokeSecretRequest(r.id, r.token);
      if (status === 204 || status === 404) {
        updateStoredRequest(r.id, { revoked: true });
        await refresh();
      } else {
        setError(message || t('request.errorRevokeFailed'));
      }
    } finally {
      setBusyId('');
    }
  }

  // Generates a fresh key pair and replaces the public key on the server.
  // Useful when the private key was lost (e.g. created in another browser
  // after importing only the management token) or should be replaced.
  async function rotateKey(r: StoredRequest) {
    setError('');
    setBusyId(r.id);
    try {
      const keyPair = await generateRequestKeyPair();
      const { status, message } = await rotateRequestKey(
        r.id,
        r.token,
        keyPair.publicKey,
      );
      if (status === 200) {
        updateStoredRequest(r.id, {
          privateKey: keyPair.privateKey,
          publicKey: keyPair.publicKey,
          fingerprint: keyPair.fingerprint,
        });
        await refresh();
      } else {
        setError(message || t('request.errorRotateFailed'));
      }
    } catch {
      setError(t('request.errorRotateFailed'));
    } finally {
      setBusyId('');
    }
  }

  function exportRequest(r: StoredRequest) {
    const blob = new Blob([exportStoredRequest(r)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yopass-request-${r.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onImport() {
    setImportError('');
    try {
      importStoredRequest(importText);
      setImportText('');
      setShowImport(false);
      refresh();
    } catch {
      setImportError(t('request.importError'));
    }
  }

  // Best-effort revocation of every request still alive on the server,
  // followed by a wipe of the local store. Entries whose revocation failed
  // (e.g. network error) are kept so their keys are not lost.
  async function purgeAll() {
    setError('');
    setBusyId('purge');
    try {
      const all = listStoredRequests();
      const failed = new Set<string>();
      await Promise.all(
        all.map(async r => {
          if (r.collected || r.revoked) return;
          const { status } = await revokeSecretRequest(r.id, r.token);
          if (status !== 204 && status !== 404) failed.add(r.id);
        }),
      );
      if (failed.size === 0) {
        clearAllStoredRequests();
      } else {
        all
          .filter(r => !failed.has(r.id))
          .forEach(r => removeStoredRequest(r.id));
        setError(t('request.errorPurgeFailed'));
      }
      await refresh();
    } finally {
      setBusyId('');
    }
  }

  async function runConfirmedAction() {
    if (!confirmAction) return;
    const { type, id } = confirmAction;
    setConfirmAction(null);
    if (type === 'clearCollected') {
      clearCollectedRequests();
      await refresh();
      return;
    }
    if (type === 'purgeAll') {
      await purgeAll();
      return;
    }
    const r = requests.find(req => req.id === id);
    if (!r) return;
    if (type === 'revoke') await revoke(r);
    if (type === 'rotate') await rotateKey(r);
    if (type === 'remove') {
      removeStoredRequest(r.id);
      await refresh();
    }
  }

  return (
    <>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="text-3xl font-bold">{t('request.listTitle')}</h2>
        <div className="flex gap-2 flex-wrap">
          {requests.some(r => r.collected) && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmAction({ type: 'clearCollected' })}
            >
              {t('request.buttonClearCollected', {
                count: requests.filter(r => r.collected).length,
              })}
            </button>
          )}
          {requests.length > 0 && (
            <button
              className="btn btn-outline btn-error btn-sm"
              disabled={busyId === 'purge'}
              onClick={() => setConfirmAction({ type: 'purgeAll' })}
            >
              {busyId === 'purge' && (
                <span className="loading loading-spinner loading-xs" />
              )}
              {t('request.buttonPurgeAll')}
            </button>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setShowImport(!showImport)}
          >
            {t('request.buttonImport')}
          </button>
          <a href="#/request" className="btn btn-primary btn-sm">
            {t('request.buttonNewRequest')}
          </a>
        </div>
      </div>
      <p className="text-base text-base-content/70 mb-6">
        {t('request.listSubtitle')}
      </p>

      {error && (
        <div className="mb-4 text-red-600 text-sm font-medium">{error}</div>
      )}

      {showImport && (
        <div className="mb-6 p-5 bg-base-200/50 border border-base-300 rounded-lg">
          <div className="font-semibold text-base mb-1">
            {t('request.importTitle')}
          </div>
          <div className="text-sm text-base-content/70 mb-3">
            {t('request.importDescription')}
          </div>
          {importError && (
            <div className="mb-2 text-red-600 text-sm font-medium">
              {importError}
            </div>
          )}
          <textarea
            className="textarea textarea-bordered w-full font-mono text-xs"
            rows={4}
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder='{"yopassSecretRequest": 1, ...}'
          />
          <button
            className="btn btn-primary btn-sm mt-2"
            onClick={onImport}
            disabled={!importText.trim()}
          >
            {t('request.buttonImportConfirm')}
          </button>
        </div>
      )}

      {requests.length === 0 ? (
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
              d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
            />
          </svg>
          <p className="text-base-content/60 mb-6">{t('request.listEmpty')}</p>
          <a href="#/request" className="btn btn-primary">
            {t('request.buttonNewRequest')}
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map(r => {
            const status = statuses[r.id] ?? 'loading';
            const busy = busyId === r.id;
            return (
              <div
                key={r.id}
                className="p-5 bg-base-200/50 border border-base-300 rounded-lg"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold text-base break-words">
                        {r.label || t('request.unnamedRequest')}
                      </span>
                      <StatusBadge status={status} />
                    </div>
                    <div className="text-xs text-base-content/60 font-mono">
                      {r.id}
                    </div>
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
                        onClick={() => viewSecret(r)}
                      >
                        {busy && (
                          <span className="loading loading-spinner loading-xs" />
                        )}
                        {t('request.buttonViewSecret')}
                      </button>
                    )}
                    {status === 'pending' && (
                      <button
                        className={`btn btn-sm ${copiedId === r.id ? 'btn-success' : 'btn-primary btn-outline'}`}
                        onClick={() => copyLink(r)}
                      >
                        {copiedId === r.id
                          ? t('common.copied')
                          : t('request.buttonCopyLink')}
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
                            <button
                              onClick={() =>
                                setConfirmAction({ type: 'rotate', id: r.id })
                              }
                            >
                              {t('request.buttonRotateKey')}
                            </button>
                          </li>
                        )}
                        {(status === 'pending' || status === 'fulfilled') && (
                          <li>
                            <button
                              onClick={() =>
                                setConfirmAction({ type: 'revoke', id: r.id })
                              }
                            >
                              {t('request.buttonRevoke')}
                            </button>
                          </li>
                        )}
                        <li>
                          <button onClick={() => exportRequest(r)}>
                            {t('request.buttonExport')}
                          </button>
                        </li>
                        <li>
                          <button
                            onClick={() =>
                              setConfirmAction({ type: 'remove', id: r.id })
                            }
                          >
                            {t('request.buttonRemove')}
                          </button>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {revealed && (
        <div className="modal modal-open" role="dialog">
          <div className="modal-box max-w-2xl">
            <h3 className="font-bold text-lg mb-2">
              {t('request.revealTitle')}
            </h3>
            <p className="text-sm text-base-content/70 mb-4">
              {t('request.revealNotice')}
            </p>
            <pre className="bg-base-200 border border-base-300 rounded-md p-4 text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
              {revealed.secret}
            </pre>
            <div className="modal-action">
              <button
                className={`btn btn-sm ${secretCopied ? 'btn-success' : 'btn-primary'}`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(revealed.secret);
                    setSecretCopied(true);
                    setTimeout(() => setSecretCopied(false), 1500);
                  } catch {
                    // noop
                  }
                }}
              >
                {secretCopied ? t('common.copied') : t('common.copy')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setRevealed(null)}
              >
                {t('request.buttonClose')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <div className="modal modal-open" role="dialog">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-2">
              {t(`request.confirm.${confirmAction.type}Title`)}
            </h3>
            <p className="text-sm text-base-content/70">
              {t(`request.confirm.${confirmAction.type}Message`)}
            </p>
            <div className="modal-action">
              <button
                className="btn btn-error btn-sm"
                onClick={runConfirmedAction}
              >
                {t(`request.confirm.${confirmAction.type}Confirm`)}
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
