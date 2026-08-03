import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useCopy } from '@shared/hooks/useCopy';
import {
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
} from '@shared/components/icons';
import ReceiptStatus from '@features/display-secret/ReceiptStatus';

interface ResultProps {
  password: string;
  uuid: string;
  prefix: string;
  customPassword: boolean;
  oneTime: boolean;
  hideOneClickLink: boolean;
  receiptToken?: string;
}

function CopyButton({
  copied,
  onClick,
  title,
  copyLabel,
  copiedLabel,
}: {
  copied: boolean;
  onClick: () => void;
  title: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <button
      className={`btn btn-sm font-medium transition-all duration-200 shrink-0 mt-1 ${copied ? 'btn-success' : 'btn-primary'}`}
      onClick={onClick}
      title={title}
    >
      {copied ? (
        <CheckIcon className="size-4" />
      ) : (
        <CopyIcon className="size-4" />
      )}
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}

function Result({
  password,
  uuid,
  prefix,
  customPassword,
  oneTime,
  hideOneClickLink,
  receiptToken,
}: ResultProps) {
  const { t } = useTranslation();
  const config = useConfig();
  const baseURL = config.PUBLIC_URL
    ? config.PUBLIC_URL.replace(/\/$/, '')
    : window.location.origin;
  const oneClickLink = `${baseURL}/#/${prefix}/${uuid}/${password}`;
  const shortLink = `${baseURL}/#/${prefix}/${uuid}`;
  const { copy, isCopied } = useCopy();

  return (
    <>
      {' '}
      <div className="flex items-center gap-3 mb-2">
        <CheckCircleIcon className="h-7 w-7 text-success" />
        <h2 className="text-2xl font-bold">{t('result.title')}</h2>
      </div>
      <p className="mb-6 text-base">{t('result.subtitle')}</p>
      {oneTime && (
        <div className="alert alert-warning mb-6 shadow-sm">
          <InfoIcon className="w-6 h-6 shrink-0" />
          <div>
            <div className="font-semibold text-base mb-1">
              {t('result.reminderTitle')}
            </div>
            <div className="text-sm opacity-90">
              {t('result.subtitleDownloadOnce')}
            </div>
          </div>
        </div>
      )}
      {oneClickLink && !customPassword && !hideOneClickLink && (
        <div className="mb-4 p-5 bg-base-200/50 border border-base-300 rounded-lg">
          <div className="font-semibold text-base mb-1 text-base-content">
            {t('result.rowLabelOneClick')}
          </div>
          <div className="text-sm text-base-content/70 mb-4">
            {t('result.rowOneClickDescription')}
          </div>
          <div className="flex items-start gap-3">
            <CopyButton
              copied={isCopied('oneClick')}
              onClick={() => copy(oneClickLink, 'oneClick')}
              title="Copy one-click link"
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
            />
            <div className="flex-1 bg-base-100 border border-base-300 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
              <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
                {oneClickLink}
              </code>
            </div>
          </div>
        </div>
      )}
      <div className="mb-4 p-5 bg-base-200/50 border border-base-300 rounded-lg">
        <div className="font-semibold text-base mb-1 text-base-content">
          {t('result.rowLabelShortLink')}
        </div>
        <div className="text-sm text-base-content/70 mb-4">
          {t('result.rowShortLinkDescription')}
        </div>
        <div className="flex items-start gap-3">
          <CopyButton
            copied={isCopied('shortLink')}
            onClick={() => copy(shortLink, 'shortLink')}
            title="Copy short link"
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
          />
          <div className="flex-1 bg-base-100 border border-base-300 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
            <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
              {shortLink}
            </code>
          </div>
        </div>
      </div>
      <div className="mb-4 p-5 bg-base-200/50 border border-base-300 rounded-lg">
        <div className="font-semibold text-base mb-1 text-base-content">
          {t('result.rowLabelDecryptionKey')}
        </div>
        <div className="text-sm text-base-content/70 mb-4">
          {t('result.rowDecryptionKeyDescription')}
        </div>
        <div className="flex items-start gap-3">
          <CopyButton
            copied={isCopied('password')}
            onClick={() => copy(password, 'password')}
            title="Copy decryption key"
            copyLabel={t('common.copy')}
            copiedLabel={t('common.copied')}
          />
          <div className="flex-1 bg-base-100 border border-base-300 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
            <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
              {password}
            </code>
          </div>
        </div>
      </div>
      {receiptToken && <ReceiptStatus uuid={uuid} token={receiptToken} />}
      <div className="flex justify-center mt-8">
        <button
          className="btn btn-ghost btn-primary px-8 font-medium transition-all duration-200"
          onClick={() => {
            window.location.href = '/';
          }}
        >
          {t('result.buttonCreateAnother')}
        </button>
      </div>
    </>
  );
}

export default Result;
