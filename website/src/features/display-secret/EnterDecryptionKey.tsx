import { useState } from "react";
import { useTranslation } from 'react-i18next';

export default function EnterDecryptionKey({
  setPassword,
  errorMessage,
}: {
  setPassword: (password: string) => void;
  errorMessage?: boolean;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input) {
      return;
    }
    setPassword(input);
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-full mt-6">
      <h2 className="text-2xl font-semibold mb-2">{t('display.titleDecryptionKey')}</h2>
      <p className="text-gray-500 mb-2">
        {t('display.inputDecryptionKeyLabel')}
      </p>
      {errorMessage && (
        <div className="mb-2 text-red-400 text-sm font-medium">
          {t('display.errorInvalidPasswordDetailed')}
        </div>
      )}
      <div className="form-control mb-6">
        <input
          type="text"
          className={`input input-bordered focus:outline-none focus:border-primary w-full${
            errorMessage
              ? " border-red-400 focus:border-red-400 focus:ring-red-400"
              : ""
          }`}
          placeholder={t('display.inputDecryptionKeyPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
      </div>
      <button type="submit" className="btn btn-primary w-full max-w-xs">
{t('display.buttonDecryptSecret')}
      </button>
    </form>
  );
}
