import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useCopy } from '@shared/hooks/useCopy';
import { copyText } from '@shared/lib/clipboard';
import { useFlowStep } from '@shared/hooks/useFlowStep';
import { useFormatDuration } from '@shared/hooks/useFormatDuration';
import {
  CheckLineIcon,
  CopyLineIcon,
  ShareIcon,
} from '@shared/components/icons';
import {
  ScreenHeading,
  StatusPill,
  outlineButtonClass,
  primaryButtonClass,
} from '@shared/components/ui';
import ReceiptStatus from '@features/display-secret/ReceiptStatus';

interface ResultProps {
  password: string;
  uuid: string;
  prefix: string;
  customPassword: boolean;
  oneTime: boolean;
  receiptToken?: string;
  // Lifetime in seconds, shown in the "deletes in" pill when known.
  expiration?: number;
}

// A read-only value with its copy button. The prominent variant (lime
// button) is used for the one-click link.
function CopyField({
  value,
  title,
  copied,
  onCopy,
  prominent = false,
}: {
  value: string;
  title: string;
  copied: boolean;
  onCopy: () => void;
  prominent?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex overflow-hidden rounded-[10px] border border-base-content/20">
      <code
        className={`block min-w-0 flex-1 truncate bg-base-200/50 font-mono ${
          prominent
            ? 'px-3.5 text-[13px] leading-[46px]'
            : 'px-3 text-[12.5px] leading-[42px]'
        }`}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title={title}
        className={
          prominent
            ? 'flex h-[46px] min-w-[104px] flex-none cursor-pointer items-center justify-center gap-[7px] border-l border-base-content/20 bg-secondary px-4 text-[13px] font-semibold text-secondary-content transition-colors duration-150 hover:bg-secondary/80'
            : 'h-[42px] min-w-[78px] flex-none cursor-pointer border-l border-base-content/20 bg-base-100 px-[13px] text-[12.5px] font-semibold text-base-content transition-colors duration-150 hover:bg-base-200 active:bg-base-300'
        }
      >
        {prominent &&
          (copied ? (
            <CheckLineIcon className="size-3.5" />
          ) : (
            <CopyLineIcon className="size-3.5" />
          ))}
        <span>{copied ? t('common.copied') : t('common.copy')}</span>
      </button>
    </div>
  );
}

function Result({
  password,
  uuid,
  prefix,
  customPassword,
  oneTime,
  receiptToken,
  expiration = 0,
}: ResultProps) {
  const { t } = useTranslation();
  const config = useConfig();
  const formatDuration = useFormatDuration();
  const baseURL = config.PUBLIC_URL
    ? config.PUBLIC_URL.replace(/\/$/, '')
    : window.location.origin;
  const oneClickLink = `${baseURL}/#/${prefix}/${uuid}/${password}`;
  const shortLink = `${baseURL}/#/${prefix}/${uuid}`;
  const { copy, isCopied } = useCopy();
  const showOneClick = !config.DISABLE_ONE_CLICK_LINK && !customPassword;
  // The link to send: one click when it may carry the key, else the short
  // link (the key or custom password travels separately).
  const primaryLink = showOneClick ? oneClickLink : shortLink;
  const [autoCopied, setAutoCopied] = useState(false);
  // The system share sheet (mostly phones) sends the link straight to a
  // messenger or mail app.
  const canShare = typeof navigator.share === 'function';
  useFlowStep(1);

  // Put the link on the clipboard as soon as it exists. Browsers only allow
  // this shortly after the user's click, so it can fail (e.g. after a slow
  // upload); the pill only appears when the copy actually happened.
  useEffect(() => {
    let current = true;
    copyText(primaryLink).then(copied => {
      if (current && copied) setAutoCopied(true);
    });
    return () => {
      current = false;
    };
  }, [primaryLink]);

  return (
    <div className="flex animate-lv-enter flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {expiration > 0 && (
            <StatusPill>
              {t('result.badgeStored', {
                expiration: formatDuration(expiration),
              })}
            </StatusPill>
          )}
          {autoCopied && (
            <span
              role="status"
              className="inline-flex h-[26px] animate-alert-enter items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12.5px] font-semibold text-secondary-content"
            >
              <CheckLineIcon className="size-3" />
              {t('result.autoCopied')}
            </span>
          )}
        </div>
        <ScreenHeading title={t('result.title')}>
          {oneTime ? t('result.subtitleDownloadOnce') : t('result.subtitle')}
        </ScreenHeading>
      </div>
      {showOneClick && (
        <div className="flex flex-col gap-[7px]">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold">
              {t('result.rowLabelOneClick')}
            </span>
            <span className="text-right text-xs text-base-content/60">
              {t('result.rowOneClickDescription')}
            </span>
          </div>
          <CopyField
            prominent
            value={oneClickLink}
            title="Copy one-click link"
            copied={isCopied('oneClick')}
            onCopy={() => copy(oneClickLink, 'oneClick')}
          />
        </div>
      )}
      <div className="grid gap-3.5 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-[7px]">
          <span className="text-[13px] font-semibold">
            {t('result.rowLabelShortLink')}
          </span>
          <CopyField
            value={shortLink}
            title="Copy short link"
            copied={isCopied('shortLink')}
            onCopy={() => copy(shortLink, 'shortLink')}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-[7px]">
          <span className="text-[13px] font-semibold">
            {customPassword
              ? t('result.rowLabelPassword')
              : t('result.rowLabelDecryptionKey')}
          </span>
          <CopyField
            value={password}
            title="Copy decryption key"
            copied={isCopied('password')}
            onCopy={() => copy(password, 'password')}
          />
        </div>
      </div>
      {receiptToken && <ReceiptStatus uuid={uuid} token={receiptToken} />}
      <div className="flex flex-wrap items-center gap-3 pt-1.5">
        {canShare && (
          <button
            type="button"
            className={primaryButtonClass}
            onClick={() =>
              navigator.share({ url: primaryLink }).catch(() => {
                // Dismissed by the user, or no share target; nothing to do.
              })
            }
          >
            <ShareIcon className="size-4 text-(--lv-arrow)" />
            {t('result.share')}
          </button>
        )}
        <button
          type="button"
          className={outlineButtonClass}
          onClick={() => {
            window.location.href = '/';
          }}
        >
          {t('result.buttonCreateAnother')}
        </button>
      </div>
    </div>
  );
}

export default Result;
