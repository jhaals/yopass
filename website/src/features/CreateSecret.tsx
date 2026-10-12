import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encryptMessage } from '@shared/lib/crypto';
import { postSecret } from '@shared/lib/api';
import { saveNewReceipt } from '@shared/lib/receiptStore';
import {
  expirationForSubmission,
  validExpiration,
} from '@shared/lib/expiration';
import { preferredExpiration } from '@shared/lib/preferences';
import { useConfig } from '@shared/hooks/useConfig';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from '@shared/components/SecretOptions';
import ComposeHeader from '@shared/components/ComposeHeader';
import PasswordGenerator from '@features/PasswordGenerator';
import { ArrowRightIcon } from '@shared/components/icons';
import { ActionBar, primaryButtonClass } from '@shared/components/ui';
import { shake } from '@shared/lib/motion';
import Result from '@features/display-secret/Result';

// The send shortcut as the keyboard prints it.
const shortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform)
  ? '⌘ Enter'
  : 'Ctrl Enter';

export default function CreateSecret() {
  const { t } = useTranslation();
  const config = useConfig();

  const [receiptToken, setReceiptToken] = useState<string | undefined>();
  const [expiresIn, setExpiresIn] = useState(0);
  const fieldRef = useRef<HTMLDivElement>(null);

  const {
    readReceipt,
    setReadReceipt,
    oneTime,
    setOneTime,
    generateKey,
    setGenerateKey,
    requireAuth,
    setRequireAuth,
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
    control,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<Secret>({
    defaultValues: {
      expiration: preferredExpiration(config),
    },
  });

  const expiration = useWatch({ control, name: 'expiration' });
  const errorMessage = errors.secret?.message?.toString();

  useEffect(() => {
    if (errorMessage) shake(fieldRef.current);
  }, [errorMessage]);

  // With a mouse and keyboard, start in the box so a secret can be pasted
  // and sent (Ctrl/⌘+Enter) straight away. Touch screens skip this so the
  // keyboard doesn't cover the page on arrival.
  useEffect(() => {
    if (window.matchMedia?.('(pointer: fine)').matches) setFocus('secret');
  }, [setFocus]);

  async function onSubmit(form: Secret) {
    if (!validExpiration(form.expiration, config)) {
      setError('secret', {
        type: 'submit',
        message: t('expiration.invalid', {
          min: config.MIN_EXPIRATION + 's',
          max: config.MAX_EXPIRATION + 's',
        }),
      });
      return;
    }
    if (!form.secret) {
      return;
    }
    try {
      const pw = getPassword();
      const encryptedMessage = await encryptMessage(
        form.secret,
        pw,
        config.ARGON2,
      );
      const ttl = expirationForSubmission(form.expiration, config);
      if (ttl === undefined)
        throw new Error(
          t('expiration.invalid', {
            min: config.MIN_EXPIRATION + 's',
            max: config.MAX_EXPIRATION + 's',
          }),
        );
      const { data, status, message } = await postSecret(
        {
          expiration: ttl,
          message: encryptedMessage,
          one_time: config.FORCE_ONETIME_SECRETS || oneTime,
          require_auth: requireAuth,
          receipt: config.READ_RECEIPTS && readReceipt,
        },
        config.OIDC_ENABLED,
      );
      if (status !== 200 || !data) {
        setError('secret', { type: 'submit', message });
      } else {
        setReceiptToken(data.receipt_token);
        setExpiresIn(ttl);
        if (data.receipt_token) {
          // Persist the receipt locally so it stays reachable from the
          // Receipts page after navigating away. The secret link and
          // decryption key are intentionally not stored.
          saveNewReceipt(
            data.message,
            data.receipt_token,
            config.FORCE_ONETIME_SECRETS || oneTime,
            ttl,
          );
        }
        setResult({
          password: pw,
          uuid: data.message,
          customPassword: isCustomPassword(),
        });
      }
    } catch (error) {
      setError('secret', {
        type: 'submit',
        message: error instanceof Error ? error.message : String(error),
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
        receiptToken={receiptToken}
        expiration={expiresIn}
      />
    );
  }

  return (
    <>
      <ComposeHeader mode="text" />
      <form
        className="flex flex-col gap-6"
        onSubmit={handleSubmit(onSubmit)}
        onKeyDown={event => {
          if (
            event.key !== 'Enter' ||
            !(event.ctrlKey || event.metaKey) ||
            event.altKey ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          ) {
            return;
          }
          event.preventDefault();
          if (!event.repeat && !isSubmitting) {
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <div ref={fieldRef} className="animate-lv-rise">
          <label className="sr-only" htmlFor="secret">
            {t('create.inputSecretLabel')}
          </label>
          <textarea
            id="secret"
            {...register('secret')}
            className="block h-[190px] w-full resize-none rounded-xl border border-base-content/20 bg-base-200/50 px-4 py-3.5 font-mono text-[13.5px] leading-relaxed text-base-content transition-colors duration-200 placeholder:text-base-content/50 focus:bg-base-100 focus:outline-2 focus:-outline-offset-1 focus:outline-(--lv-focus)"
            placeholder={t('create.inputSecretPlaceholder')}
          />
        </div>

        <SecretOptions
          expiration={expiration}
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

        {errorMessage && (
          <div
            role="alert"
            className="-mt-2 animate-alert-enter text-[13px] text-error"
          >
            {errorMessage}
          </div>
        )}

        <ActionBar>
          <button
            className={primaryButtonClass}
            type="submit"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={isSubmitting}
          >
            {t('create.buttonEncrypt')}
            <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
          </button>
          <kbd
            aria-hidden="true"
            className="hidden font-mono text-xs text-base-content/50 pointer-fine:inline"
          >
            {shortcutLabel}
          </kbd>
        </ActionBar>
      </form>
      <PasswordGenerator />
    </>
  );
}
