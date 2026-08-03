import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encryptMessage } from '@shared/lib/crypto';
import { postSecret } from '@shared/lib/api';
import { saveNewReceipt } from '@shared/lib/receiptStore';
import { useConfig } from '@shared/hooks/useConfig';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from '@shared/components/SecretOptions';
import Result from '@features/display-secret/Result';

export default function CreateSecret() {
  const { t } = useTranslation();
  const config = useConfig();

  const [requireAuth, setRequireAuth] = useState(false);
  const [readReceipt, setReadReceipt] = useState(false);
  const [receiptToken, setReceiptToken] = useState<string | undefined>();

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
    isCustomPassword,
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
    setValue,
    formState: { errors },
  } = useForm<Secret>({
    defaultValues: {
      expiration: String(config.DEFAULT_EXPIRY ?? 3600),
    },
  });

  async function onSubmit(form: Secret) {
    if (!form.secret) {
      return;
    }
    const pw = getPassword();
    const { data, status } = await postSecret(
      {
        expiration: parseInt(form.expiration),
        message: await encryptMessage(form.secret, pw, config.ARGON2),
        one_time: config.FORCE_ONETIME_SECRETS || oneTime,
        require_auth: requireAuth,
        receipt: config.READ_RECEIPTS && readReceipt,
      },
      config.OIDC_ENABLED,
    );
    if (status !== 200) {
      setError('secret', { type: 'submit', message: data.message });
    } else {
      setReceiptToken(data.receipt_token);
      if (data.receipt_token) {
        // Persist the receipt locally so it stays reachable from the
        // Receipts page after navigating away. The secret link and
        // decryption key are intentionally not stored.
        saveNewReceipt(
          data.message,
          data.receipt_token,
          config.FORCE_ONETIME_SECRETS || oneTime,
          parseInt(form.expiration),
        );
      }
      setResult({
        password: pw,
        uuid: data.message,
        customPassword: isCustomPassword(),
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
        oneTime={config.FORCE_ONETIME_SECRETS || oneTime}
        hideOneClickLink={config?.HIDE_ONECLICK_LINK || false}
        receiptToken={receiptToken}
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
          <label className="label" htmlFor="secret">
            <span className="label-text">{t('create.inputSecretLabel')}</span>
          </label>
          <textarea
            id="secret"
            {...register('secret')}
            className="textarea textarea-bordered w-full min-h-[140px] text-base p-4 resize-y rounded-lg focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 bg-base-100"
            placeholder={t('create.inputSecretPlaceholder')}
            rows={4}
          />
        </div>

        <SecretOptions
          register={register}
          setValue={setValue}
          oneTime={oneTime}
          setOneTime={setOneTime}
          generateKey={generateKey}
          setGenerateKey={setGenerateKey}
          customPassword={customPassword}
          setCustomPassword={setCustomPassword}
          requireAuth={requireAuth}
          setRequireAuth={setRequireAuth}
          readReceipt={readReceipt}
          setReadReceipt={setReadReceipt}
        />

        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg transition-all duration-200"
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
