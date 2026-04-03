import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { encrypt, createMessage } from 'openpgp';
import { encryptionConfig } from '@shared/lib/crypto';
import { uploadStreamingFile, createBundle } from '@shared/lib/api';
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function StreamingUpload() {
  const { t } = useTranslation();
  const config = useConfig();
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [currentFileIndex, setCurrentFileIndex] = useState<number | null>(null);

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
      return false;
    }
    return true;
  }

  function addFiles(newFiles: FileList | File[]) {
    const validFiles: File[] = [];
    for (const f of Array.from(newFiles)) {
      if (validateFile(f)) {
        validFiles.push(f);
      }
    }
    if (validFiles.length > 0) {
      setError(null);
      setFiles((prev) => [...prev, ...validFiles]);
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      addFiles(droppedFiles);
    }
  }

  async function encryptAndUploadFile(
    file: File,
    pw: string,
    expiration: number,
    isOneTime: boolean,
    onProgress: (pct: number) => void,
  ): Promise<{ key: string }> {
    const message = await createMessage({
      binary: file.stream() as ReadableStream<Uint8Array>,
      filename: file.name,
    });

    const encrypted = await encrypt({
      message,
      passwords: pw,
      config: encryptionConfig,
      format: 'binary',
    });

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
              onProgress(next);
            }
          }
        },
      }),
    );
    const encryptedBlob = await new Response(progressStream).blob();
    onProgress(95);

    const { data: res, status } = await uploadStreamingFile({
      body: encryptedBlob,
      expiration,
      oneTime: isOneTime,
      filename: file.name,
    });

    if (status !== 200) {
      throw new Error(res.message);
    }

    onProgress(100);
    return { key: res.message };
  }

  async function onSubmit(form: FormValues) {
    setError(null);
    setProgress(null);
    setCurrentFileIndex(null);

    if (files.length === 0) {
      setError(t('upload.errorSelectFile'));
      return;
    }

    const pw = getPassword();
    const expiration = parseInt(form.expiration);
    const isOneTime = config?.FORCE_ONETIME_SECRETS || oneTime;

    try {
      // Single file: use existing flow (backward compatible)
      if (files.length === 1) {
        const file = files[0];
        setProgress(0);
        setCurrentFileIndex(0);

        const { key } = await encryptAndUploadFile(
          file,
          pw,
          expiration,
          isOneTime,
          (pct) => setProgress(pct),
        );

        setResult({
          password: pw,
          uuid: key,
          customPassword: isCustomPassword(),
        });
        return;
      }

      // Multi-file: encrypt and upload each, then create bundle
      setProgress(0);
      const fileKeys: string[] = [];
      const filenames: string[] = [];
      const sizes: number[] = [];

      for (let i = 0; i < files.length; i++) {
        setCurrentFileIndex(i);
        const file = files[i];
        const { key } = await encryptAndUploadFile(
          file,
          pw,
          expiration,
          isOneTime,
          (pct) => {
            const overallProgress = Math.round(
              (i * 100 + pct) / files.length,
            );
            setProgress(Math.min(95, overallProgress));
          },
        );

        fileKeys.push(key);
        filenames.push(file.name);
        sizes.push(file.size);
      }

      setCurrentFileIndex(null);
      setProgress(97);

      // Create the bundle
      const { data: bundleRes, status: bundleStatus } = await createBundle(
        fileKeys,
        filenames,
        sizes,
        expiration,
        isOneTime,
      );

      if (bundleStatus !== 200) {
        setError(bundleRes.message);
        setProgress(null);
        return;
      }

      setResult({
        password: pw,
        uuid: bundleRes.message,
        customPassword: isCustomPassword(),
      });
    } catch (err) {
      setError((err as Error).message);
      setProgress(null);
    }
  }

  if (result.uuid) {
    const prefix = files.length > 1 ? 'b' : 'f';
    return (
      <Result
        password={result.password}
        uuid={result.uuid}
        prefix={prefix}
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
            multiple
            onChange={(e) => {
              const fileList = e.target.files;
              if (fileList && fileList.length > 0) {
                addFiles(fileList);
              }
              // Reset input so the same files can be selected again
              e.target.value = '';
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
                {files.length > 0
                  ? t('upload.addMoreFiles', {
                      defaultValue: 'Click or drag to add more files',
                    })
                  : t('upload.dragDropText')}
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

        {/* Selected files list */}
        {files.length > 0 && (
          <div className="mb-6">
            <div className="text-sm font-semibold mb-2">
              {t('upload.selectedFiles', {
                count: files.length,
                defaultValue: '{{count}} file(s) selected',
              })}
            </div>
            <div className="space-y-2">
              {files.map((file, index) => (
                <div
                  key={`${file.name}-${file.size}-${index}`}
                  className="flex items-center justify-between bg-base-200 border border-base-300 rounded-lg px-4 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="w-5 h-5 shrink-0 text-base-content/60"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                      />
                    </svg>
                    <span className="truncate text-sm">{file.name}</span>
                    <span className="text-xs text-base-content/50 shrink-0">
                      ({formatFileSize(file.size)})
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-error"
                    onClick={() => removeFile(index)}
                    disabled={progress !== null}
                    title={t('upload.removeFile', {
                      defaultValue: 'Remove file',
                    })}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="w-4 h-4"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18 18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {progress !== null && (
          <div className="mb-6">
            <div className="flex justify-between text-sm mb-1">
              <span>
                {currentFileIndex !== null && files.length > 1
                  ? t('upload.encryptingFile', {
                      current: currentFileIndex + 1,
                      total: files.length,
                      defaultValue: `Encrypting file {{current}} of {{total}}...`,
                    })
                  : t('upload.encrypting', {
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
          expirationLabel={t('upload.expirationLegendFile')}
        />

        <div className="form-control mt-8">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg transition-all duration-200"
            type="submit"
            disabled={files.length === 0 || progress !== null}
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
            {files.length > 1
              ? t('upload.uploadFilesButton', {
                  count: files.length,
                  defaultValue: 'Upload {{count}} files',
                })
              : t('upload.uploadFileButton')}
          </button>
        </div>
      </form>
    </>
  );
}
