import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, PadlockIcon } from '@shared/components/icons';
import {
  IconTile,
  ScreenHeading,
  primaryButtonClass,
} from '@shared/components/ui';

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
    <div className="flex animate-lv-enter flex-col gap-6">
      <IconTile>
        <PadlockIcon className="size-[22px]" />
      </IconTile>
      <ScreenHeading title={t('display.titleDecryptionKey')}>
        {t('display.inputDecryptionKeyLabel')}
      </ScreenHeading>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {/* Remounted per failed attempt by the caller, replaying the shake. */}
        <div
          className={`grid max-w-[380px] gap-[7px] ${errorMessage ? 'animate-decrypt-error' : ''}`}
        >
          <label htmlFor="decryption-key" className="text-[13px] font-semibold">
            {t('display.inputDecryptionKeyPlaceholder')}
          </label>
          <input
            id="decryption-key"
            type="text"
            className={`h-11 rounded-[10px] border bg-base-100 px-[13px] font-mono text-[13px] text-base-content placeholder:text-base-content/50 focus:outline-2 focus:-outline-offset-1 ${
              errorMessage
                ? 'border-error focus:outline-error'
                : 'border-base-content/20 focus:outline-(--lv-focus)'
            }`}
            placeholder={t('display.inputDecryptionKeyPlaceholder')}
            value={input}
            onChange={e => setInput(e.target.value)}
            aria-invalid={errorMessage || undefined}
            autoFocus
          />
          {errorMessage && (
            <span role="alert" className="text-[12.5px] text-error">
              {t('display.errorInvalidPasswordDetailed')}
            </span>
          )}
        </div>

        <div className="flex">
          <button type="submit" className={primaryButtonClass}>
            {t('display.buttonDecryptSecret')}
            <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
          </button>
        </div>
      </form>
    </div>
  );
}
