import { useTranslation } from 'react-i18next';

export interface RevealedFile {
  data: Uint8Array<ArrayBuffer>;
  filename: string;
}

interface RevealSecretModalProps {
  secret?: string;
  file?: RevealedFile;
  undecrypted?: boolean;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RevealSecretModal({
  secret,
  file,
  undecrypted,
  copied,
  onCopy,
  onDownload,
  onClose,
}: RevealSecretModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal modal-open" role="dialog">
      <div className="modal-box max-w-2xl">
        <h3 className="font-bold text-lg mb-2">{t('request.revealTitle')}</h3>
        <p className="text-sm text-base-content/70 mb-4">
          {file ? t('request.revealFileNotice') : t('request.revealNotice')}
        </p>
        {undecrypted && (
          <div className="alert alert-warning mb-4 text-sm" role="alert">
            {t('request.errorDecryptFailed')}
          </div>
        )}
        {file ? (
          <div className="flex items-center gap-3 bg-base-200 border border-base-300 rounded-md p-4">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-8 h-8 shrink-0 text-base-content/60"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
              />
            </svg>
            <div className="min-w-0">
              <div className="font-medium break-words">{file.filename}</div>
              <div className="text-xs text-base-content/60">
                {formatBytes(file.data.byteLength)}
              </div>
            </div>
          </div>
        ) : (
          <pre className="bg-base-200 border border-base-300 rounded-md p-4 text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
            {secret}
          </pre>
        )}
        <div className="modal-action">
          {file ? (
            <button className="btn btn-sm btn-primary" onClick={onDownload}>
              {t('request.buttonDownloadFile')}
            </button>
          ) : (
            <button
              className={`btn btn-sm ${copied ? 'btn-success' : 'btn-primary'}`}
              onClick={onCopy}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('request.buttonClose')}
          </button>
        </div>
      </div>
    </div>
  );
}
