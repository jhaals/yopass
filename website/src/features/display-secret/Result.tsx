import { useTranslation } from 'react-i18next';
interface ResultProps {
  password: string;
  uuid: string;
  prefix: string;
  customPassword: boolean;
  oneTime: boolean;
}

function Result({
  password,
  uuid,
  prefix,
  customPassword,
  oneTime,
}: ResultProps) {
  const { t } = useTranslation();
  const oneClickLink = `${window.location.origin}/#/${prefix}/${uuid}/${password}`;
  const shortLink = `${window.location.origin}/#/${prefix}/${uuid}`;

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  return (
    <>
      {' '}
      <h2 className="text-3xl font-bold mb-2">{t('result.title')}</h2>
      <p className="mb-6 text-base">{t('result.subtitle')}</p>
      {oneTime && (
        <div className="alert alert-warning mb-6 shadow-sm">
          <svg
            className="w-6 h-6 stroke-current shrink-0"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M13 16h-1v-4h-1m1-4h.01M12 20a8 8 0 100-16 8 8 0 000 16z"
            />
          </svg>
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
      {oneClickLink && !customPassword && (
        <div className="mb-6 p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm hover:shadow-md transition-shadow">
          <div className="font-semibold text-lg mb-2 text-base-content">
            {t('result.rowLabelOneClick')}
          </div>
          <div className="text-sm text-base-content/70 mb-4">
            {t('result.rowOneClickDescription')}
          </div>
          <div className="flex items-start gap-3">
            <button
              className="btn btn-primary btn-sm font-medium shadow-sm hover:shadow transition-all duration-200 shrink-0 mt-1"
              onClick={() => copyToClipboard(oneClickLink)}
              title="Copy one-click link"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
                className="size-4"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
                />
              </svg>
            </button>
            <div className="flex-1 bg-base-200/50 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
              <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
                {oneClickLink}
              </code>
            </div>
          </div>
        </div>
      )}
      <div className="mb-6 p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm hover:shadow-md transition-shadow">
        <div className="font-semibold text-lg mb-2 text-base-content">
          {t('result.rowLabelShortLink')}
        </div>
        <div className="text-sm text-base-content/70 mb-4">
          {t('result.rowShortLinkDescription')}
        </div>
        <div className="flex items-start gap-3">
          <button
            className="btn btn-primary btn-sm font-medium shadow-sm hover:shadow transition-all duration-200 shrink-0 mt-1"
            onClick={() => copyToClipboard(shortLink)}
            title="Copy short link"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              className="size-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
              />
            </svg>
          </button>
          <div className="flex-1 bg-base-200/50 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
            <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
              {shortLink}
            </code>
          </div>
        </div>
      </div>
      <div className="mb-8 p-6 bg-base-100 border border-base-300 rounded-lg shadow-sm hover:shadow-md transition-shadow">
        <div className="font-semibold text-lg mb-2 text-base-content">
          {t('result.rowLabelDecryptionKey')}
        </div>
        <div className="text-sm text-base-content/70 mb-4">
          {t('result.rowDecryptionKeyDescription')}
        </div>
        <div className="flex items-start gap-3">
          <button
            className="btn btn-primary btn-sm font-medium shadow-sm hover:shadow transition-all duration-200 shrink-0 mt-1"
            onClick={() => copyToClipboard(password)}
            title="Copy decryption key"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
              className="size-4"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8.25 7.5V6.108c0-1.135.845-2.098 1.976-2.192.373-.03.748-.057 1.123-.08M15.75 18H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08M15.75 18.75v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5A3.375 3.375 0 0 0 6.375 7.5H5.25m11.9-3.664A2.251 2.251 0 0 0 15 2.25h-1.5a2.251 2.251 0 0 0-2.15 1.586m5.8 0c.065.21.1.433.1.664v.75h-6V4.5c0-.231.035-.454.1-.664M6.75 7.5H4.875c-.621 0-1.125.504-1.125 1.125v12c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V16.5a9 9 0 0 0-9-9Z"
              />
            </svg>
          </button>
          <div className="flex-1 bg-base-200/50 rounded-md px-4 py-3 min-h-[2.5rem] min-w-0">
            <code className="text-sm text-base-content/80 font-mono break-words leading-relaxed">
              {password}
            </code>
          </div>
        </div>
      </div>
      <div className="flex justify-center mt-8">
        <button
          className="btn btn-outline btn-primary px-8 font-medium shadow-sm hover:shadow transition-all duration-200"
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
