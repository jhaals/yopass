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
  expirationLabel,
}: SecretOptionsProps) {
  const { t } = useTranslation();
  const config = useConfig();

  const maxExpiration = config?.FORCE_EXPIRATION || 604800;
  const expirationOptions = [
    { value: 3600, label: t('expiration.optionOneHourLabel') },
    { value: 86400, label: t('expiration.optionOneDayLabel') },
    { value: 604800, label: t('expiration.optionOneWeekLabel') },
  ].filter((option) => option.value <= maxExpiration);

  const getExpirationLabel = (seconds: number) => {
    if (seconds === 3600) return '1 hour';
    if (seconds === 86400) return '1 day';
    if (seconds === 604800) return '1 week';
    return `${seconds} seconds`;
  };

  return (
    <>
      <div className="form-control mt-6">
        <label className="label">
          <span className="label-text font-semibold text-base text-balance">
            {expirationLabel || t('expiration.legend')}
          </span>
        </label>
        {config?.FORCE_EXPIRATION && (
          <div className="alert alert-info mb-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              className="stroke-current shrink-0 w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              ></path>
            </svg>
            <span>
              {t('expiration.serverEnforcedMaximumExpiration', {
                value: getExpirationLabel(config.FORCE_EXPIRATION),
              })}
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-4 mt-2">
          {expirationOptions.map((option, index) => (
            <label
              key={option.value}
              className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors"
            >
              <input
                type="radio"
                {...register('expiration')}
                className="radio radio-primary"
                defaultChecked={index === 0}
                value={option.value}
              />
              <span className="label-text font-medium">{option.label}</span>
            </label>
          ))}
        </div>
        <div className="mt-6 space-y-4">
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
        </div>
        {!generateKey && (
          <div className="mt-4">
            <label className="label">
              <span className="label-text font-medium">
                {t('create.inputCustomPasswordLabel')}
              </span>
            </label>
            <input
              type="password"
              {...register('customPassword')}
              className="input input-bordered w-full focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              value={customPassword}
              onChange={e => setCustomPassword(e.target.value)}
              placeholder={t('create.inputCustomPasswordPlaceholder')}
            />
          </div>
        )}
      </div>
    </>
  );
}
