import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorCircleIcon, KeyIcon, UnlockIcon } from '@shared/components/icons';

export default function EnterDecryptionKey({
  setPassword,
  errorMessage,
}: {
  setPassword: (password: string) => void;
  errorMessage?: boolean;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input) {
      return;
    }
    setPassword(input);
  }

  return (
    <div className="max-w-full mt-6">
      <div className="flex items-center mb-4">
        <KeyIcon className="h-8 w-8 text-primary mr-3" />
        <h2 className="text-3xl font-bold">
          {t('display.titleDecryptionKey')}
        </h2>
      </div>

      <p className="text-base-content/70 mb-6 text-lg">
        {t('display.inputDecryptionKeyLabel')}
      </p>

      {errorMessage && (
        <div className="alert alert-error mb-6 shadow-sm">
          <ErrorCircleIcon className="w-6 h-6 shrink-0" />
          <div>
            <div className="font-semibold text-base">
              {t('display.errorInvalidPasswordDetailed')}
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-control mb-8">
          <input
            type="text"
            className={`input input-bordered w-full text-lg p-4 rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${
              errorMessage ? 'input-error' : ''
            }`}
            placeholder={t('display.inputDecryptionKeyPlaceholder')}
            value={input}
            onChange={e => setInput(e.target.value)}
            autoFocus
          />
        </div>

        <div className="flex justify-center">
          <button
            type="submit"
            className="btn btn-primary px-12 py-4 h-12 text-base font-semibold rounded-lg transition-all duration-200 max-w-md w-full"
          >
            <UnlockIcon className="h-6 w-6 mr-2" />
            {t('display.buttonDecryptSecret')}
          </button>
        </div>
      </form>
    </div>
  );
}
