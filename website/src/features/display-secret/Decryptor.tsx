import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { useParams } from 'react-router-dom';
import { useAsync } from 'react-use';
import { decryptMessage } from '@shared/lib/crypto';
import { downloadBlob } from '@shared/lib/download';
import { useCopy } from '@shared/hooks/useCopy';
import DecryptingSpinner from '@shared/components/DecryptingSpinner';
import EnterDecryptionKey from './EnterDecryptionKey';
import FileDownloadedCard from './FileDownloadedCard';

// Secrets longer than this render no QR code option; the dense codes are
// unreadable and many encoders reject them.
const maxQRCodeLength = 500;

export default function Decryptor({ secret }: { secret: string }) {
  const { t } = useTranslation();
  const { format, password: paramsPassword } = useParams();
  const [password, setPassword] = useState(() => paramsPassword ?? '');
  const [showQR, setShowQR] = useState(false);
  const { copy, isCopied } = useCopy();

  const { loading, error, value } = useAsync(async () => {
    if (!password) {
      return;
    }
    const message = await decryptMessage(
      secret,
      password,
      format === 'f' ? 'binary' : 'utf8',
    );

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

  const tooLongForQRCode = value && value?.data?.length > maxQRCodeLength;

  // Automatically download file when decrypted
  useEffect(() => {
    if (value && value.isFile) {
      downloadBlob(
        new Uint8Array(value.data as Uint8Array),
        value.filename || 'download',
      );
    }
  }, [value]);

  function handleCopy() {
    if (!value || value.isFile) return;
    copy(value.data as string);
  }

  if (loading) {
    return <DecryptingSpinner />;
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
        <FileDownloadedCard filename={value.filename || 'download'} />
        <button
          className="btn btn-primary flex items-center gap-2 min-w-[200px]"
          onClick={() =>
            downloadBlob(
              new Uint8Array(value.data as Uint8Array),
              value.filename || 'download',
            )
          }
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
          className="h-8 w-8 text-success mr-2"
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
      <div className="mb-8 bg-base-200/70 border border-base-300 rounded-lg p-6 text-base font-mono whitespace-pre-wrap min-h-[120px] text-base-content break-words">
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
          {isCopied()
            ? t('secret.buttonCopied')
            : t('secret.buttonCopyToClipboard')}
        </button>

        {!tooLongForQRCode && (
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
        )}
      </div>
      {showQR && !tooLongForQRCode && (
        <div className="mt-8 flex justify-center">
          <div className="bg-base-100 border border-base-300 rounded-lg p-6 shadow-sm">
            <QRCodeSVG
              size={250}
              style={{ height: 'auto' }}
              value={value.data as string}
            />
          </div>
        </div>
      )}
    </>
  );
}
