import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseFormRegister, UseFormSetValue } from 'react-hook-form';
import { useConfig } from '@shared/hooks/useConfig';

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
  expirationLabel?: string;
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
  expirationLabel,
}: SecretOptionsProps<T>) {
  const register = registerProp as unknown as UseFormRegister<SecretFormFields>;
  const setValue = setValueProp as unknown as UseFormSetValue<SecretFormFields>;
  const { t } = useTranslation();
  const config = useConfig();

  const forceExpiration = config?.FORCE_EXPIRATION;
  const forcedExpirationLabel = forceExpiration
    ? forceExpiration === 3600
      ? t('expiration.optionOneHourLabel')
      : forceExpiration === 86400
        ? t('expiration.optionOneDayLabel')
        : forceExpiration === 604800
          ? t('expiration.optionOneWeekLabel')
          : t('expiration.optionOneHourLabel')
    : undefined;

  useEffect(() => {
    if (forceExpiration) {
      setValue('expiration', String(forceExpiration));
    }
  }, [forceExpiration, setValue]);

  return (
    <>
      <fieldset className="form-control mt-6">
        {!forcedExpirationLabel && (
          <legend className="label-text font-semibold text-base text-balance">
            {expirationLabel || t('expiration.legend')}
          </legend>
        )}
        {forcedExpirationLabel ? (
          <p className="mt-2 text-sm font-medium text-base-content/70">
            {t('expiration.forced', {
              expiration: forcedExpirationLabel.toLowerCase(),
              defaultValue: `Secret will expire in {{expiration}}`,
            })}
          </p>
        ) : (
          <div className="join w-full mt-2">
            {[
              { value: '3600', label: t('expiration.optionOneHourLabel') },
              { value: '86400', label: t('expiration.optionOneDayLabel') },
              { value: '604800', label: t('expiration.optionOneWeekLabel') },
            ].map(option => (
              <input
                key={option.value}
                type="radio"
                {...register('expiration')}
                className="join-item btn btn-sm flex-1"
                value={option.value}
                aria-label={option.label}
              />
            ))}
          </div>
        )}
        <div className="mt-6 space-y-3">
          {!config?.FORCE_ONETIME_SECRETS && (
            <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
              <input
                type="checkbox"
                className="checkbox checkbox-primary"
                {...register('oneTime')}
                checked={oneTime}
                onChange={() => setOneTime(!oneTime)}
              />
              <span className="label-text font-medium">
                {t('create.inputOneTimeLabel')}
              </span>
            </label>
          )}
          <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
            <input
              type="checkbox"
              className="checkbox checkbox-primary"
              {...register('generateKey')}
              checked={generateKey}
              onChange={() => setGenerateKey(!generateKey)}
            />
            <span className="label-text font-medium">
              {t('create.inputGenerateKeyLabel')}
            </span>
          </label>
          {config?.OIDC_ENABLED && (
            <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
              <input
                type="checkbox"
                className="checkbox checkbox-primary"
                checked={requireAuth}
                onChange={() => setRequireAuth(!requireAuth)}
              />
              <span className="label-text font-medium">
                {t('create.inputRequireAuthLabel')}
              </span>
            </label>
          )}
        </div>
      </fieldset>
      {!generateKey && (
        <div className="mt-4">
          <label className="label" htmlFor="customPassword">
            <span className="label-text font-medium">
              {t('create.inputCustomPasswordLabel')}
            </span>
          </label>
          <input
            id="customPassword"
            type="password"
            {...register('customPassword')}
            className="input input-bordered w-full rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            value={customPassword}
            onChange={e => setCustomPassword(e.target.value)}
            placeholder={t('create.inputCustomPasswordPlaceholder')}
          />
        </div>
      )}
    </>
  );
}
