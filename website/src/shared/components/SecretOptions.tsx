import { useTranslation } from 'react-i18next';
import type { UseFormRegister } from 'react-hook-form';
import { useConfig } from '@shared/hooks/useConfig';

interface SecretOptionsProps {
  // Using any here to allow this component to work with different form types
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: UseFormRegister<any>;
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

export function SecretOptions({
  register,
  oneTime,
  setOneTime,
  generateKey,
  setGenerateKey,
  customPassword,
  setCustomPassword,
  requireAuth,
  setRequireAuth,
  expirationLabel,
}: SecretOptionsProps) {
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
          : undefined
    : undefined;

  return (
    <>
      <div className="form-control mt-6">
        <label className="label">
          <span className="label-text font-semibold text-base text-balance">
            {expirationLabel || t('expiration.legend')}
          </span>
        </label>
        {forcedExpirationLabel ? (
          <div className="mt-2 text-sm">
            {t('expiration.forced', {
              expiration: forcedExpirationLabel,
              defaultValue: `Secret will expire in {{expiration}}`,
            })}
            <input
              type="hidden"
              {...register('expiration')}
              value={String(forceExpiration)}
            />
          </div>
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
      </div>
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
