import { useTranslation } from 'react-i18next';
import type { UseFormRegister, UseFormSetValue } from 'react-hook-form';
import { ExpirationSelector } from './ExpirationSelector';
import { useConfig } from '@shared/hooks/useConfig';
import { saveExpiration } from '@shared/lib/preferences';

type SecretFormFields = {
  expiration: string;
  oneTime: boolean;
  generateKey: boolean;
  customPassword: string;
};

interface SecretOptionsProps<T extends SecretFormFields> {
  register: UseFormRegister<T>;
  setValue: UseFormSetValue<T>;
  oneTime: boolean;
  setOneTime: (value: boolean) => void;
  generateKey: boolean;
  setGenerateKey: (value: boolean) => void;
  customPassword: string;
  setCustomPassword: (value: string) => void;
  requireAuth: boolean;
  setRequireAuth: (value: boolean) => void;
  readReceipt?: boolean;
  setReadReceipt?: (value: boolean) => void;
  expirationLabel?: string;
  expiration: string;
}

export function SecretOptions<T extends SecretFormFields>({
  register: registerProp,
  setValue: setValueProp,
  oneTime,
  setOneTime,
  generateKey,
  setGenerateKey,
  customPassword,
  setCustomPassword,
  requireAuth,
  setRequireAuth,
  readReceipt,
  setReadReceipt,
  expirationLabel,
  expiration,
}: SecretOptionsProps<T>) {
  const register = registerProp as unknown as UseFormRegister<SecretFormFields>;
  const setValue = setValueProp as unknown as UseFormSetValue<SecretFormFields>;
  const { t } = useTranslation();
  const config = useConfig();

  return (
    <div className="divide-y divide-base-300 overflow-hidden rounded-xl border border-base-300">
      <ExpirationSelector
        value={expiration}
        onChange={value => {
          setValue('expiration', value);
          saveExpiration(value);
        }}
        legend={expirationLabel}
      />
      {!config?.FORCE_ONETIME_SECRETS && (
        <SwitchRow
          label={t('create.inputOneTimeLabel')}
          hint={t('create.inputOneTimeHint')}
          checked={oneTime}
          onChange={() => setOneTime(!oneTime)}
          inputProps={register('oneTime')}
        />
      )}
      <div>
        <SwitchRow
          label={t('create.inputGenerateKeyLabel')}
          hint={t('create.inputGenerateKeyHint')}
          checked={generateKey}
          onChange={() => setGenerateKey(!generateKey)}
          inputProps={register('generateKey')}
        />
        {!generateKey && (
          <div className="animate-lv-drop px-4 pb-4">
            <label className="sr-only" htmlFor="customPassword">
              {t('create.inputCustomPasswordLabel')}
            </label>
            <input
              id="customPassword"
              type="password"
              {...register('customPassword')}
              className="h-[42px] w-full rounded-[10px] border border-base-content/20 bg-base-100 px-[13px] font-mono text-[13px] text-base-content placeholder:text-base-content/50 focus:outline-2 focus:-outline-offset-1 focus:outline-(--lv-focus)"
              value={customPassword}
              onChange={e => setCustomPassword(e.target.value)}
              placeholder={t('create.inputCustomPasswordPlaceholder')}
            />
          </div>
        )}
      </div>
      {config?.OIDC_ENABLED && (
        <SwitchRow
          label={t('create.inputRequireAuthLabel')}
          checked={requireAuth}
          onChange={() => setRequireAuth(!requireAuth)}
        />
      )}
      {config?.READ_RECEIPTS && setReadReceipt && (
        <SwitchRow
          label={t('create.inputReadReceiptLabel')}
          checked={!!readReceipt}
          onChange={() => setReadReceipt(!readReceipt)}
        />
      )}
    </div>
  );
}

// One option row: title, optional hint and a switch. The whole row is the
// label, so clicking anywhere on it toggles the option.
function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  inputProps,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
  inputProps?: ReturnType<UseFormRegister<SecretFormFields>>;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-4 px-4 py-3.5 transition-colors duration-150 select-none hover:bg-base-200/60 active:bg-base-200">
      <span className="flex-1">
        <span className="block text-[13.5px] font-semibold">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-[12.5px] text-base-content/60">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="lv-switch"
        {...inputProps}
        checked={checked}
        onChange={onChange}
      />
    </label>
  );
}
