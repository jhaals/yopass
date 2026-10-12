import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { useParams } from 'react-router-dom';
import { useAsync } from 'react-use';
import { decryptMessage } from '@shared/lib/crypto';
import { downloadBlob } from '@shared/lib/download';
import { useCopy } from '@shared/hooks/useCopy';
import DecryptingSpinner from '@shared/components/DecryptingSpinner';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import {
  CheckLineIcon,
  CopyLineIcon,
  QrCodeIcon,
  TrayDownloadIcon,
} from '@shared/components/icons';
import { ScreenHeading, StatusPill } from '@shared/components/ui';
import EnterDecryptionKey from './EnterDecryptionKey';
import FileDownloadedCard from './FileDownloadedCard';

// Secrets longer than this render no QR code option; the dense codes are
// unreadable and many encoders reject them.
const maxQRCodeLength = 500;

export default function Decryptor({
  secret,
  initialPassword,
}: {
  secret: string;
  initialPassword: string;
}) {
  const { t } = useTranslation();
  const { format } = useParams();
  const [password, setPassword] = useState(initialPassword);
  const [attempt, setAttempt] = useState(0);
  const [failedAttempt, setFailedAttempt] = useState(0);
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
    ).catch(error => {
      // Replay feedback only once this attempt has actually failed.
      setFailedAttempt(attempt + 1);
      throw error;
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
  }, [password, secret, format, attempt]);

  const tooLongForQRCode = value && value?.data?.length > maxQRCodeLength;
  useFlowStep(value && !error ? 3 : 2);

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
        key={failedAttempt}
        setPassword={nextPassword => {
          setPassword(nextPassword);
          setAttempt(current => current + 1);
        }}
        errorMessage={Boolean(error)}
      />
    );
  }

  // Show different UI for files vs text secrets
  if (value && value.isFile) {
    return (
      <FileDownloadedCard filename={value.filename || 'download'}>
        <button
          className="flex h-[42px] cursor-pointer items-center gap-2 rounded-[10px] bg-primary px-4 text-[13.5px] font-semibold text-primary-content transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[.97]"
          onClick={() =>
            downloadBlob(
              new Uint8Array(value.data as Uint8Array),
              value.filename || 'download',
            )
          }
          aria-label={t('secret.buttonDownloadFile')}
        >
          <TrayDownloadIcon className="size-[15px] text-(--lv-arrow)" />
          {t('secret.buttonDownloadFile')}
        </button>
      </FileDownloadedCard>
    );
  }

  return (
    <div className="flex animate-lv-reveal flex-col gap-6">
      <div className="flex flex-col gap-3">
        <StatusPill>{t('secret.badgeDecrypted')}</StatusPill>
        <ScreenHeading title={t('secret.titleMessage')}>
          {t('secret.subtitleMessage')}
        </ScreenHeading>
      </div>
      <div className="overflow-hidden rounded-xl border border-base-content/20">
        <div className="min-h-[120px] bg-base-200/50 px-[18px] py-4 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap">
          {value.data as string}
        </div>
        <div className="flex flex-wrap items-center gap-2.5 border-t border-base-300 bg-base-100 px-3 py-2.5">
          <button
            className={`flex h-[38px] min-w-32 cursor-pointer items-center justify-center gap-[7px] rounded-[9px] bg-secondary max-sm:h-11 max-sm:flex-1 px-3.5 text-[13px] font-semibold text-secondary-content transition-[background-color,transform] duration-150 hover:bg-secondary/80 active:scale-[.97] ${isCopied() ? 'animate-copy-confirm' : ''}`}
            onClick={handleCopy}
            aria-label={t('secret.buttonCopyToClipboard')}
          >
            {isCopied() ? (
              <CheckLineIcon className="size-3.5" />
            ) : (
              <CopyLineIcon className="size-3.5" />
            )}
            {isCopied()
              ? t('secret.buttonCopied')
              : t('secret.buttonCopyToClipboard')}
          </button>
          {!tooLongForQRCode && (
            <button
              className="ml-auto flex h-[38px] cursor-pointer items-center gap-2 rounded-[9px] px-2 text-[13px] font-semibold text-base-content/70 transition-colors hover:text-base-content"
              onClick={() => setShowQR(v => !v)}
              type="button"
              aria-label={
                showQR ? t('secret.hideQrCode') : t('secret.showQrCode')
              }
            >
              <QrCodeIcon className="size-4" />
              {showQR ? t('secret.hideQrCode') : t('secret.showQrCode')}
            </button>
          )}
        </div>
      </div>
      {showQR && !tooLongForQRCode && (
        <div className="flex animate-lv-drop">
          <div className="rounded-xl border border-base-300 bg-white p-5">
            <QRCodeSVG
              size={220}
              style={{ height: 'auto' }}
              value={value.data as string}
            />
          </div>
        </div>
      )}
    </div>
  );
}
