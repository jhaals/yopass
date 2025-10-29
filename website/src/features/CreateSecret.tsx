import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encryptMessage } from '@shared/lib/crypto';
import { postSecret } from '@shared/lib/api';
import { useConfig } from '@shared/hooks/useConfig';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from '@shared/components/SecretOptions';
import Result from '@features/display-secret/Result';

export default function CreateSecret() {
  const { t } = useTranslation();
  const config = useConfig();
  const [secret, setSecret] = useState('');

  const {
    oneTime,
    setOneTime,
    generateKey,
    setGenerateKey,
    customPassword,
    setCustomPassword,
    result,
    setResult,
    getPassword,
  } = useSecretForm();

  type Secret = {
    secret: string;
    expiration: string;
    oneTime: boolean;
    generateKey: boolean;
    customPassword: string;
  };
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Secret>();

  async function onSubmit(form: Secret) {
    if (!form.secret) {
      return;
    }
    const pw = getPassword();
    const { data, status } = await postSecret({
      expiration: parseInt(form.expiration),
      message: await encryptMessage(form.secret, pw),
      one_time: config?.FORCE_ONETIME_SECRETS || oneTime,
    });
    if (status !== 200) {
      setError('secret', { type: 'submit', message: data.message });
    } else {
      setResult({
        password: pw,
        uuid: data.message,
        customPassword: !!customPassword && !generateKey,
      });
    }
  }

  if (result.uuid) {
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix="s"
        customPassword={result.customPassword}
        oneTime={config?.FORCE_ONETIME_SECRETS || oneTime}
      />
    );
  }

  return (
    <>
      <h2 className="text-3xl font-bold mb-4">{t('create.title')}</h2>
      <form onSubmit={handleSubmit(onSubmit)}>
        {errors.secret && (
          <div className="mb-4 text-red-600 text-sm font-medium">
            {errors.secret.message?.toString()}
          </div>
        )}
        <div className="form-control">
          <label className="label">
            <span className="label-text">{t('create.inputSecretLabel')}</span>
          </label>
          <textarea
            {...register('secret')}
            className="textarea textarea-bordered w-full min-h-[100px] text-base p-4 resize-y focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary bg-base-100"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            placeholder={t('create.inputSecretPlaceholder')}
            rows={4}
          />
        </div>

        <SecretOptions
          register={register}
          oneTime={oneTime}
          setOneTime={setOneTime}
          generateKey={generateKey}
          setGenerateKey={setGenerateKey}
          customPassword={customPassword}
          setCustomPassword={setCustomPassword}
        />

        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-14 text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-200"
            type="submit"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6 mr-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            {t('create.buttonEncrypt')}
          </button>
        </div>
      </form>
    </>
  );
}
