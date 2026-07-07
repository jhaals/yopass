import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDownloadIcon, FileListIcon } from '@shared/components/icons';

// Success view shown after a file secret has been decrypted and downloaded:
// title, subtitle and a card naming the file. children render inside the
// card, below the filename (e.g. a re-download link).
export default function FileDownloadedCard({
  filename,
  children,
}: {
  filename: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-center mb-2">
        <FileListIcon className="h-8 w-8 text-success mr-2" />
        <h2 className="text-3xl font-bold">{t('secret.titleFile')}</h2>
      </div>
      <p className="mb-6 text-base-content/70">{t('secret.subtitleFile')}</p>
      <div className="mb-6">
        <div className="bg-base-200 border border-base-300 rounded-xl p-6">
          <div className="flex items-center">
            <FileDownloadIcon className="h-6 w-6 mr-2" />
            <span className="text-lg">
              {t('secret.fileDownloaded')}: <strong>{filename}</strong>
            </span>
          </div>
          {children}
        </div>
      </div>
    </>
  );
}
