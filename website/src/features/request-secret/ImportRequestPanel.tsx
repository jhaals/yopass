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

  function onImport() {
    setImportError('');
    try {
      importStoredRequest(importText);
      setImportText('');
      onImported();
    } catch {
      setImportError(t('request.importError'));
    }
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
  );
}
