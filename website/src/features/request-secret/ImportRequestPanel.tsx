import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { importStoredRequest } from '@shared/lib/requestStore';

interface ImportRequestPanelProps {
  // Called after a request was successfully imported into the local store.
  onImported: () => void;
}

export default function ImportRequestPanel({
  onImported,
}: ImportRequestPanelProps) {
  const { t } = useTranslation();
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [dragActive, setDragActive] = useState(false);

  function importJson(json: string) {
    setImportError('');
    try {
      importStoredRequest(json);
      setImportText('');
      onImported();
    } catch {
      setImportError(t('request.importError'));
    }
  }

  // Reads the exported file locally — the contents never leave the browser.
  async function importFile(file: File) {
    setImportError('');
    let json: string;
    try {
      json = await file.text();
    } catch {
      setImportError(t('request.importError'));
      return;
    }
    importJson(json);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) importFile(f);
  }

  return (
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
      <div
        data-testid="import-dropzone"
        className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
          dragActive
            ? 'border-primary bg-base-200'
            : 'border-base-300 bg-base-100'
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          className="hidden"
          id="request-import-file-input"
          accept=".json,application/json"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            // Allow re-selecting the same file after a failed import.
            e.target.value = '';
          }}
        />
        <label
          htmlFor="request-import-file-input"
          className="cursor-pointer block"
        >
          <div className="flex flex-col items-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-8 h-8 text-base-content/60"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
            <div className="mt-1 text-sm font-medium">
              {t('request.importDropText')}
            </div>
          </div>
        </label>
      </div>
      <div className="divider my-1 text-xs text-base-content/60">
        {t('request.importDivider')}
      </div>
      <textarea
        className="textarea textarea-bordered w-full font-mono text-xs"
        rows={4}
        value={importText}
        onChange={e => setImportText(e.target.value)}
        placeholder='{"yopassSecretRequest": 1, ...}'
      />
      <button
        className="btn btn-primary btn-sm mt-2"
        onClick={() => importJson(importText)}
        disabled={!importText.trim()}
      >
        {t('request.buttonImportConfirm')}
      </button>
    </div>
  );
}
