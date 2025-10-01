import { readMessage } from 'openpgp';
import { decrypt } from 'openpgp';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'react-qr-code';
import { useParams } from 'react-router-dom';
import { useAsync } from 'react-use';
import EnterDecryptionKey from './EnterDecryptionKey';

export default function Decryptor({ secret }: { secret: string }) {
  const { t } = useTranslation();
  const { format, password: paramsPassword } = useParams();
  const [password, setPassword] = useState(() => paramsPassword ?? '');
  const tooLongForQRCode = secret.length > 500;
  const [showQR, setShowQR] = useState(false);
  const [copied, setCopied] = useState(false);

  const { loading, error, value } = useAsync(async () => {
    if (!password) {
      return;
    }
    const message = await decrypt({
      message: await readMessage({ armoredMessage: secret }),
      passwords: password,
      format: format === 'f' ? 'binary' : 'utf8',
    });

    if (format === 'f') {
      // For files, return an object with binary data and filename
      return {
        data: message.data as Uint8Array,
        filename: (message as { filename?: string }).filename || 'download',
        isFile: true,
      };
    }

    return {
      data: message.data as string,
      isFile: false,
    };
  }, [password, secret, format]);

  // Automatically download file when decrypted
  useEffect(() => {
    if (value && value.isFile) {
      const blob = new Blob([new Uint8Array(value.data as Uint8Array)], {
        type: 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = value.filename || 'download';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }, [value]);

  async function handleCopy() {
    try {
      if (!value || value.isFile) return;
      await navigator.clipboard.writeText(value.data as string);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-base-content/70">
        <svg
          className="animate-spin h-8 w-8 text-primary"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          ></path>
        </svg>
        <p className="mt-4 text-lg font-medium">
          {t('display.decryptingMessage')}
        </p>
      </div>
    );
  }

  if (error || !value) {
    return (
      <EnterDecryptionKey
        setPassword={setPassword}
        errorMessage={Boolean(error)}
      />
    );
  }

  // Show different UI for files vs text secrets
  if (value && value.isFile) {
    return (
      <>
        <div className="flex items-center mb-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-8 w-8 text-green-500 mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
            />
          </svg>
          <h2 className="text-3xl font-bold">{t('secret.titleFile')}</h2>
        </div>
        <p className="mb-6 text-base-content/70">{t('secret.subtitleFile')}</p>
        <div className="mb-6">
          <div className="bg-base-200 border border-base-300 rounded-xl p-6">
            <div className="flex items-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="h-6 w-6 mr-2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25"
                />
              </svg>
              <span className="text-lg">
                {t('secret.fileDownloaded')}: <strong>{value.filename}</strong>
              </span>
            </div>
          </div>
        </div>
        <button
          className="btn btn-primary flex items-center gap-2 min-w-[200px]"
          onClick={() => {
            const blob = new Blob([new Uint8Array(value.data as Uint8Array)], {
              type: 'application/octet-stream',
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = value.filename || 'download';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
          }}
          aria-label={t('secret.buttonDownloadFile')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-6 w-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
            />
          </svg>
          {t('secret.buttonDownloadFile')}
        </button>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center mb-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="h-8 w-8 text-green-500 mr-2"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M13.5 10.5V6.75a4.5 4.5 0 1 1 9 0v3.75M3.75 21.75h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H3.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
          />
        </svg>
        <h2 className="text-3xl font-bold">{t('secret.titleMessage')}</h2>
      </div>
      <p className="mb-6 text-base-content/70">{t('secret.subtitleMessage')}</p>
      <div className="mb-8 bg-base-200 rounded-lg p-6 text-lg font-mono whitespace-pre-wrap min-h-[120px] text-base-content">
        {value.data as string}
      </div>
      <div className="flex flex-wrap gap-4 justify-center mb-6">
        <button
          className="btn btn-primary flex items-center gap-3 px-8 font-medium shadow-sm hover:shadow transition-all duration-200"
          onClick={handleCopy}
          aria-label={t('secret.buttonCopyToClipboard')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-5 w-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
            />
          </svg>
          {copied
            ? t('secret.buttonCopied')
            : t('secret.buttonCopyToClipboard')}
        </button>
        <button
          className="btn btn-outline btn-primary flex items-center gap-3 px-8 font-medium shadow-sm hover:shadow transition-all duration-200"
          onClick={() => setShowQR(v => !v)}
          type="button"
          aria-label={
            showQR && !tooLongForQRCode
              ? t('secret.hideQrCode')
              : t('secret.showQrCode')
          }
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-5 w-5"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z"
            />
          </svg>
          {showQR && !tooLongForQRCode
            ? t('secret.hideQrCode')
            : t('secret.showQrCode')}
        </button>
      </div>
      {showQR && !tooLongForQRCode && (
        <div className="mt-8 flex justify-center">
          <div className="bg-base-100 border border-base-300 rounded-lg p-6 shadow-sm">
            <QRCode
              size={180}
              style={{ height: 'auto' }}
              value={value.data as string}
            />
          </div>
        </div>
      )}
    </>
  );
}
