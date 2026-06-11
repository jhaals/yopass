import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useCopy } from '@shared/hooks/useCopy';
import {
  fetchRequestSecret,
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
  listStoredRequests,
  removeStoredRequest,
  updateStoredRequest,
  type StoredRequest,
} from '@shared/lib/requestStore';
import { requestLink, shortFingerprint } from './requestLink';
import { useStoredRequests } from './useStoredRequests';
import RequestCard from './RequestCard';
import RevealSecretModal from './RevealSecretModal';
import ConfirmActionModal, {
  type ConfirmActionType,
} from './ConfirmActionModal';
import ImportRequestPanel from './ImportRequestPanel';

export default function RequestList() {
  const { t } = useTranslation();
  const config = useConfig();
  const { requests, statuses, refresh } = useStoredRequests();
  const links = useCopy();
  const secret = useCopy();
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [revealed, setRevealed] = useState<{
    id: string;
    secret: string;
    undecrypted?: boolean;
  } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: ConfirmActionType;
    id?: string;
  } | null>(null);

  function copyLink(r: StoredRequest) {
    links.copy(
      requestLink(config.PUBLIC_URL, r.id, shortFingerprint(r.fingerprint)),
      r.id,
    );
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
      // The server deleted the ciphertext when it was fetched, so this is
      // the only copy. If local decryption fails, show the ciphertext so it
      // can be saved and decrypted elsewhere instead of being lost.
      updateStoredRequest(r.id, { collected: true });
      try {
        const decrypted = await decryptWithPrivateKey(
          data.message,
          r.privateKey,
        );
        setRevealed({ id: r.id, secret: decrypted });
      } catch {
        setRevealed({ id: r.id, secret: data.message, undecrypted: true });
      }
      await refresh();
    } catch {
      setError(t('request.errorFetchFailed'));
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
        <ImportRequestPanel
          onImported={() => {
            setShowImport(false);
            refresh();
          }}
        />
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
          {requests.map(r => (
            <RequestCard
              key={r.id}
              request={r}
              status={statuses[r.id] ?? 'loading'}
              busy={busyId === r.id}
              copied={links.isCopied(r.id)}
              onCopyLink={() => copyLink(r)}
              onViewSecret={() => viewSecret(r)}
              onRotateKey={() => setConfirmAction({ type: 'rotate', id: r.id })}
              onRevoke={() => setConfirmAction({ type: 'revoke', id: r.id })}
              onExport={() => exportRequest(r)}
              onRemove={() => setConfirmAction({ type: 'remove', id: r.id })}
            />
          ))}
        </div>
      )}

      {revealed && (
        <RevealSecretModal
          secret={revealed.secret}
          undecrypted={revealed.undecrypted}
          copied={secret.isCopied()}
          onCopy={() => secret.copy(revealed.secret)}
          onClose={() => setRevealed(null)}
        />
      )}

      {confirmAction && (
        <ConfirmActionModal
          type={confirmAction.type}
          onConfirm={runConfirmedAction}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
}
