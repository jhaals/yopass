import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encrypt, createMessage } from 'openpgp';
import { getEncryptionConfig } from '@shared/lib/crypto';
import { uploadStreamingFile } from '@shared/lib/api';
import { parseSize } from '@shared/lib/parseSize';
import { useConfig } from '@shared/hooks/useConfig';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from '@shared/components/SecretOptions';
import Result from '@features/display-secret/Result';

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

  const [requireAuth, setRequireAuth] = useState(false);

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

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      expiration: String(config?.DEFAULT_EXPIRY ?? 3600),
      oneTime: true,
      generateKey: true,
      customPassword: '',
    },
  });

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
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

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) validateFile(f);
  }

  async function onSubmit(form: FormValues) {
    setError(null);
    setProgress(null);
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

      const { data: res, status } = await uploadStreamingFile({
        body: encryptedBlob,
        expiration: parseInt(form.expiration),
        oneTime: config?.FORCE_ONETIME_SECRETS || oneTime,
        requireAuth,
        oidcEnabled: config.OIDC_ENABLED,
      });

      if (status !== 200) {
        setError(res.message);
        setProgress(null);
        return;
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
      />
    );
  }

  return (
    <>
      <h2 className="text-3xl font-bold mb-4">{t('upload.title')}</h2>

      {error && (
        <div
          className="alert alert-error mb-4 cursor-pointer"
          onClick={() => setError(null)}
        >
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        <div
          className={`border-2 border-dashed rounded-xl p-8 mb-6 text-center transition-colors ${
            dragActive
              ? 'border-primary bg-base-200'
              : 'border-base-300 bg-base-100'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            className="hidden"
            id="stream-file-input"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) validateFile(f);
            }}
          />
          <label htmlFor="stream-file-input" className="cursor-pointer block">
            <div className="flex flex-col items-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-14 h-14 text-base-content/60"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3V15"
                />
              </svg>
              <div className="mt-2 font-semibold">
                {file ? file.name : t('upload.dragDropText')}
              </div>
              {config?.MAX_FILE_SIZE && (
                <div className="text-sm text-base-content/60">
                  {t('upload.maxFileSize', {
                    size: config.MAX_FILE_SIZE,
                  })}
                </div>
              )}
            </div>
          </label>
        </div>

        {progress !== null && (
          <div className="mb-6">
            <div className="flex justify-between text-sm mb-1">
              <span>
                {t('upload.encrypting', {
                  defaultValue: 'Encrypting & uploading...',
                })}
              </span>
              <span>{progress}%</span>
            </div>
            <progress
              className="progress progress-primary w-full"
              value={progress}
              max="100"
            />
          </div>
        )}

        <SecretOptions
          register={register}
          oneTime={oneTime}
          setOneTime={setOneTime}
          generateKey={generateKey}
          setGenerateKey={setGenerateKey}
          customPassword={customPassword}
          setCustomPassword={setCustomPassword}
          requireAuth={requireAuth}
          setRequireAuth={setRequireAuth}
          expirationLabel={t('upload.expirationLegendFile')}
        />

        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg transition-all duration-200"
            type="submit"
            disabled={!file || progress !== null}
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
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
            {t('upload.uploadFileButton')}
          </button>
        </div>
      </form>
    </>
  );
}
