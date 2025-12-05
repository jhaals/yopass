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

  return (
    <>
      <div className="form-control mt-6">
        <label className="label">
          <span className="label-text font-semibold text-base text-balance">
            {expirationLabel || t('expiration.legend')}
          </span>
        </label>
        <div className="flex flex-wrap gap-4 mt-2">
          <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
            <input
              type="radio"
              {...register('expiration')}
              className="radio radio-primary"
              defaultChecked={true}
              value="3600"
            />
            <span className="label-text font-medium">
              {t('expiration.optionOneHourLabel')}
            </span>
          </label>
          <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
            <input
              type="radio"
              {...register('expiration')}
              className="radio radio-primary"
              value="86400"
            />
            <span className="label-text font-medium">
              {t('expiration.optionOneDayLabel')}
            </span>
          </label>
          <label className="cursor-pointer flex items-center space-x-3 p-2 rounded-md hover:bg-base-200 transition-colors">
            <input
              type="radio"
              {...register('expiration')}
              className="radio radio-primary"
              value="604800"
            />
            <span className="label-text font-medium">
              {t('expiration.optionOneWeekLabel')}
            </span>
          </label>
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
