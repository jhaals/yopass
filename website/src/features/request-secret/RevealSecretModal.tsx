import { useTranslation } from 'react-i18next';

interface RevealSecretModalProps {
  secret: string;
  undecrypted?: boolean;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

export default function RevealSecretModal({
  secret,
  undecrypted,
  copied,
  onCopy,
  onClose,
}: RevealSecretModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box max-w-2xl">
        <h3 className="font-bold text-lg mb-2">{t('request.revealTitle')}</h3>
        <p className="text-sm text-base-content/70 mb-4">
          {t('request.revealNotice')}
        </p>
        {undecrypted && (
          <div className="alert alert-warning mb-4 text-sm" role="alert">
            {t('request.errorDecryptFailed')}
          </div>
        )}
        <pre className="bg-base-200 border border-base-300 rounded-md p-4 text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
          {secret}
        </pre>
        <div className="modal-action">
          <button
            className={`btn btn-sm ${copied ? 'btn-success' : 'btn-primary'}`}
            onClick={onCopy}
          >
            {copied ? t('common.copied') : t('common.copy')}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('request.buttonClose')}
          </button>
        </div>
      </div>
    </div>
  );
}
