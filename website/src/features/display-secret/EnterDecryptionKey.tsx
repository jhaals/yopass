import { useState } from 'react';
import { useTranslation } from 'react-i18next';

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
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8 text-primary mr-3"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
          />
        </svg>
        <h2 className="text-3xl font-bold">
          {t('display.titleDecryptionKey')}
        </h2>
      </div>

      <p className="text-base-content/70 mb-6 text-lg">
        {t('display.inputDecryptionKeyLabel')}
      </p>

      {errorMessage && (
        <div className="alert alert-error mb-6 shadow-sm">
          <svg
            className="w-6 h-6 stroke-current shrink-0"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
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
            className={`input input-bordered w-full text-lg p-4 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary ${
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
            className="btn btn-primary px-12 py-4 h-16 text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-200 max-w-md w-full"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-6 w-6 mr-2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
            {t('display.buttonDecryptSecret')}
          </button>
        </div>
      </form>
    </div>
  );
}
