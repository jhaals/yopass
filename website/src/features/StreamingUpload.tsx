import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encrypt, createMessage } from 'openpgp';
import { getEncryptionConfig } from '@shared/lib/crypto';
import { uploadStreamingFile } from '@shared/lib/api';
import { saveNewReceipt } from '@shared/lib/receiptStore';
import { parseSize } from '@shared/lib/parseSize';
import {
  expirationForSubmission,
  validExpiration,
} from '@shared/lib/expiration';
import { preferredExpiration } from '@shared/lib/preferences';
import { useConfig } from '@shared/hooks/useConfig';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from '@shared/components/SecretOptions';
import Result from '@features/display-secret/Result';
import ComposeHeader from '@shared/components/ComposeHeader';
import { ArrowRightIcon, FileIcon, FileUpIcon } from '@shared/components/icons';
import { ActionBar, IconTile, primaryButtonClass } from '@shared/components/ui';
import { shake } from '@shared/lib/motion';

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

type FormValues = {
  expiration: string;
  oneTime: boolean;
  generateKey: boolean;
  customPassword: string;
};

export default function StreamingUpload() {
  const { t } = useTranslation();
  const config = useConfig();
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const [receiptToken, setReceiptToken] = useState<string | undefined>();
  const [expiresIn, setExpiresIn] = useState(0);
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) shake(fieldRef.current);
  }, [error]);

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

  const { register, handleSubmit, setValue, control } = useForm<FormValues>({
    defaultValues: {
      expiration: preferredExpiration(config),
      oneTime,
      generateKey: true,
      customPassword: '',
    },
  });

  const expiration = useWatch({ control, name: 'expiration' });

  function handleDragOver(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragActive(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }
  function validateFile(f: File): boolean {
    const maxBytes = parseSize(config?.MAX_FILE_SIZE ?? '');
    if (maxBytes > 0 && f.size > maxBytes) {
      setError(
        t('upload.fileTooLarge', { maxSize: config?.MAX_FILE_SIZE ?? '' }),
      );
      setFile(null);
      return false;
    }
    setError(null);
    setFile(f);
    return true;
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) validateFile(f);
  }

  async function onSubmit(form: FormValues) {
    setError(null);
    setProgress(null);
    if (!validExpiration(form.expiration, config)) {
      setError(
        t('expiration.invalid', {
          min: config.MIN_EXPIRATION + 's',
          max: config.MAX_EXPIRATION + 's',
        }),
      );
      return;
    }
    if (!file) {
      setError(t('upload.errorSelectFile'));
      return;
    }

    const pw = getPassword();
    try {
      setProgress(0);

      // Create a streaming OpenPGP message from the file
      const message = await createMessage({
        binary: file.stream() as ReadableStream<Uint8Array>,
        filename: file.name,
      });

      // Encrypt with binary format (not armored) for efficiency
      const encrypted = await encrypt({
        message,
        passwords: pw,
        config: getEncryptionConfig(config?.ARGON2),
        format: 'binary',
      });

      // Pipe the encrypted stream through a progress-tracking transform,
      // then let the browser collect it into a Blob. Using new Response().blob()
      // allows the browser to back the Blob with temp files for large uploads
      // instead of holding all chunks in JS heap memory.
      const totalSize = file.size;
      let processed = 0;
      let lastProgress = -1;
      const progressStream = (
        encrypted as ReadableStream<Uint8Array>
      ).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            processed += chunk.byteLength;
            if (totalSize > 0) {
              const next = Math.min(
                90,
                Math.round((processed / totalSize) * 100),
              );
              if (next !== lastProgress) {
                lastProgress = next;
                setProgress(next);
              }
            }
          },
        }),
      );
      const encryptedBlob = await new Response(progressStream).blob();
      setProgress(95);
      const ttl = expirationForSubmission(form.expiration, config);
      if (ttl === undefined)
        throw new Error(
          t('expiration.invalid', {
            min: config.MIN_EXPIRATION + 's',
            max: config.MAX_EXPIRATION + 's',
          }),
        );

      const {
        data: res,
        status,
        message: apiError,
      } = await uploadStreamingFile({
        body: encryptedBlob,
        expiration: ttl,
        oneTime: config?.FORCE_ONETIME_SECRETS || oneTime,
        requireAuth,
        receipt: config?.READ_RECEIPTS && readReceipt,
        oidcEnabled: config.OIDC_ENABLED,
      });

      if (status !== 200 || !res) {
        setError(apiError ?? t('upload.errorFailedToRead'));
        setProgress(null);
        return;
      }

      setReceiptToken(res.receipt_token);
      setExpiresIn(ttl);
      if (res.receipt_token) {
        // Persist the receipt locally so it stays reachable from the
        // Receipts page after navigating away. The file link and
        // decryption key are intentionally not stored.
        saveNewReceipt(
          res.message,
          res.receipt_token,
          config?.FORCE_ONETIME_SECRETS || oneTime,
          ttl,
          'file',
        );
      }
      setResult({
        password: pw,
        uuid: res.message,
        customPassword: isCustomPassword(),
      });
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  }

  if (result.uuid) {
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix="f"
        customPassword={result.customPassword}
        oneTime={config?.FORCE_ONETIME_SECRETS || oneTime}
        receiptToken={receiptToken}
        expiration={expiresIn}
      />
    );
  }

  return (
    <>
      <ComposeHeader mode="file" />
      <form className="flex flex-col gap-6" onSubmit={handleSubmit(onSubmit)}>
        <div ref={fieldRef} className="animate-lv-rise">
          {/* Stays mounted while a file is selected so choosing another replaces it. */}
          <input
            type="file"
            className="hidden"
            id="stream-file-input"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) validateFile(f);
            }}
          />
          {file ? (
            <div className="flex h-[190px] items-center gap-[18px] rounded-xl border border-base-content/20 bg-base-200/50 px-5 sm:px-7">
              <IconTile tone="lime" size="md">
                <FileIcon className="size-[22px]" />
              </IconTile>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-[15px] font-semibold">
                  {file.name}
                </span>
                <span className="font-mono text-xs text-base-content/60">
                  {formatBytes(file.size)} · {t('upload.fileReady')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  setError(null);
                }}
                disabled={progress !== null}
                className="ml-auto h-[34px] flex-none cursor-pointer rounded-lg border border-base-content/20 bg-base-100 px-3 text-[12.5px] font-semibold transition-[background-color,transform] duration-150 hover:bg-base-200 active:scale-[.97] disabled:opacity-40"
              >
                {t('upload.buttonRemove')}
              </button>
            </div>
          ) : (
            <label
              htmlFor="stream-file-input"
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex h-[190px] cursor-pointer items-center gap-[18px] rounded-xl border-[1.5px] border-dashed px-5 transition-[transform,background-color,border-color] duration-300 ease-lv sm:px-7 ${
                dragActive
                  ? 'scale-[1.012] border-base-content bg-secondary/15'
                  : 'border-base-content/25 bg-base-200/50'
              }`}
            >
              <IconTile>
                <FileUpIcon className="size-[22px]" />
              </IconTile>
              <span className="flex flex-col gap-1">
                <span className="text-[15px] font-semibold">
                  {dragActive ? (
                    t('upload.dropRelease')
                  ) : (
                    <>
                      {/* Touch screens have no drag and drop; they pick. */}
                      <span className="pointer-coarse:hidden">
                        {t('upload.dragDropText')}
                      </span>
                      <span className="hidden pointer-coarse:inline">
                        {t('upload.chooseFile')}
                      </span>
                    </>
                  )}
                </span>
                <span className="text-[13px] text-base-content/60">
                  <span className="pointer-coarse:hidden">
                    {t('upload.dropHint')}
                  </span>
                  {config?.MAX_FILE_SIZE &&
                    ` ${t('upload.maxFileSize', { size: config.MAX_FILE_SIZE })}`}
                </span>
              </span>
            </label>
          )}
        </div>

        {progress !== null && (
          <div className="-mt-2">
            <div className="mb-1.5 flex justify-between font-mono text-xs text-base-content/70">
              <span>{t('upload.encrypting')}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-base-200">
              <div
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-full rounded-full bg-secondary transition-[width] duration-300 ease-lv"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

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

        {error && (
          <div
            role="alert"
            className="-mt-2 animate-alert-enter cursor-pointer text-[13px] text-error"
            onClick={() => setError(null)}
          >
            {error}
          </div>
        )}

        <ActionBar>
          <button
            className={primaryButtonClass}
            type="submit"
            disabled={!file || progress !== null}
          >
            {t('upload.uploadFileButton')}
            <ArrowRightIcon className="size-4 text-(--lv-arrow)" />
          </button>
        </ActionBar>
      </form>
    </>
  );
}
