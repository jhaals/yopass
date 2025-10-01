import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { randomString } from '@shared/lib/random';
import { uploadFile } from '@shared/lib/api';
import { encrypt, createMessage } from 'openpgp';
import { useConfig } from '@shared/hooks/useConfig';
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
  const [oneTime, setOneTime] = useState(true);
  const [generateKey, setGenerateKey] = useState(true);
  const [customPassword, setCustomPassword] = useState('');
  const [result, setResult] = useState({
    password: '',
    uuid: '',
    customPassword: false,
  });

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

    const pw = !generateKey && customPassword ? customPassword : randomString();
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
        one_time: config?.FORCE_ONETIME_SECRETS || form.oneTime,
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

        <div className="form-control mt-6">
          <label className="label">
            <span className="label-text font-semibold text-base text-balance">
              {t('upload.expirationLegendFile')}
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
