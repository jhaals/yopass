import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { uploadFile } from '@shared/lib/api';
import { encrypt, createMessage } from 'openpgp';
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

export default function Upload() {
  const { t } = useTranslation();
  const config = useConfig();
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      expiration: '3600',
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
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }

  async function onSubmit(form: FormValues) {
    setError(null);
    if (!file) {
      setError(t('upload.errorSelectFile'));
      return;
    }

    const pw = getPassword();
    try {
      const reader = new FileReader();
      const data = await new Promise<ArrayBuffer>((resolve, reject) => {
        reader.onerror = () => reject(new Error(t('upload.errorFailedToRead')));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });

      const message = await encrypt({
        format: 'armored',
        message: await createMessage({
          binary: new Uint8Array(data),
          filename: file.name,
        }),
        passwords: pw,
      });

      const { data: res, status } = await uploadFile({
        expiration: parseInt(form.expiration),
        message,
        one_time: config?.FORCE_ONETIME_SECRETS || oneTime,
      });

      if (status !== 200) {
        setError(res.message);
        return;
      }

      setResult({
        password: pw,
        uuid: res.message,
        customPassword: !!customPassword && !generateKey,
      });
    } catch (err) {
      setError((err as Error).message);
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
            id="file-input"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
          <label htmlFor="file-input" className="cursor-pointer block">
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
              <div className="text-sm text-base-content/60">
                {t('upload.fileDescription')}
              </div>
            </div>
          </label>
        </div>

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
            className="btn btn-primary w-full h-14 text-lg font-semibold shadow-lg hover:shadow-xl transition-all duration-200"
            type="submit"
            disabled={!file}
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
