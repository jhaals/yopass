import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileIcon } from '@shared/components/icons';
import { ScreenHeading, StatusPill } from '@shared/components/ui';

// Success view shown after a file secret has been decrypted and downloaded:
// heading and a row naming the file. children render at the end of the row
// (e.g. a re-download button).
export default function FileDownloadedCard({
  filename,
  children,
}: {
  filename: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex animate-lv-reveal flex-col gap-6">
      <div className="flex flex-col gap-3">
        <StatusPill>{t('secret.badgeDecrypted')}</StatusPill>
        <ScreenHeading title={t('secret.titleFile')}>
          {t('secret.subtitleFile')}
        </ScreenHeading>
      </div>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-base-content/20 bg-base-200/50 px-5 py-[18px]">
        <span className="grid size-12 flex-none place-items-center rounded-xl bg-secondary text-secondary-content">
          <FileIcon className="size-[22px]" />
        </span>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate text-[15px] font-semibold">{filename}</span>
          <span className="font-mono text-xs text-base-content/60">
            {t('secret.fileDownloaded')}
          </span>
        </div>
        <div className="ml-auto">{children}</div>
      </div>
    </div>
  );
}
