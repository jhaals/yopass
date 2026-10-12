import { useEffect, useState } from 'react';
import { useConfig } from '../hooks/useConfig';
import { useAuth } from '../hooks/useAuth';
import SettingsMenu from './SettingsMenu';
import { FingerprintMark } from './Brand';
import { ShieldCheckIcon } from './icons';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { backendDomain } from '../lib/api';
import { countFulfilledRequests } from '../lib/requestStatus';
import { REQUESTS_CHANGED_EVENT } from '../lib/requestStore';

export default function Navbar() {
  const {
    APP_NAME,
    HIDE_APP_NAME,
    LOGO_URL,
    OIDC_ENABLED,
    SECRET_REQUESTS,
    READ_RECEIPTS,
  } = useConfig();
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const [fulfilledCount, setFulfilledCount] = useState(0);

  // Badge with the number of requests whose secret is waiting to be
  // collected. Refreshes on navigation, whenever the local request store
  // changes, and on a slow poll for secrets provided while the tab is open.
  useEffect(() => {
    if (!SECRET_REQUESTS) return;
    let cancelled = false;
    async function refresh() {
      const count = await countFulfilledRequests();
      if (!cancelled) setFulfilledCount(count);
    }
    refresh();
    window.addEventListener(REQUESTS_CHANGED_EVENT, refresh);
    const interval = setInterval(refresh, 30000);
    return () => {
      cancelled = true;
      window.removeEventListener(REQUESTS_CHANGED_EVENT, refresh);
      clearInterval(interval);
    };
  }, [SECRET_REQUESTS, location.pathname]);

  function navLink(active: boolean) {
    return `flex h-8 items-center gap-1.5 rounded-lg px-2 sm:px-2.5 text-[13px] font-medium transition-colors duration-150 select-none pointer-coarse:h-10 pointer-coarse:px-3 active:bg-base-300 ${
      active
        ? 'bg-base-200 text-base-content'
        : 'text-base-content/70 hover:bg-base-200 hover:text-base-content'
    }`;
  }

  return (
    <header className="sticky top-0 z-30 flex h-[calc(4rem+env(safe-area-inset-top))] flex-none items-center gap-[11px] border-b border-base-300 bg-base-100/90 px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] backdrop-blur-md sm:px-8">
      <a
        className="flex min-w-0 items-center gap-[11px] text-base-content no-underline"
        href="/"
        aria-label={APP_NAME ?? t('header.appName')}
      >
        {LOGO_URL ? (
          <img
            src={LOGO_URL}
            alt={APP_NAME ?? t('header.appName')}
            className="h-[34px] w-auto max-w-16 shrink-0 object-contain"
          />
        ) : (
          <FingerprintMark className="size-[34px] shrink-0" />
        )}
        {!HIDE_APP_NAME &&
          (APP_NAME ? (
            <span className="truncate text-lg font-semibold tracking-[-.03em]">
              {APP_NAME}
            </span>
          ) : (
            <span className="flex items-baseline gap-px">
              <span className="text-lg font-semibold tracking-[-.03em]">
                urlx
              </span>
              <span className="font-mono text-[13px] font-medium text-base-content/55">
                .net
              </span>
            </span>
          ))}
      </a>
      <span
        aria-hidden="true"
        className="mx-1 hidden h-[18px] w-px bg-base-content/20 md:block"
      />
      <span className="hidden truncate text-[13px] text-base-content/75 md:block">
        {t('brand.tagline')}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <span className="mr-2 hidden items-center gap-[7px] font-mono text-[11.5px] text-base-content/55 lg:flex">
          <ShieldCheckIcon className="size-3.5" />
          {t('brand.e2e')}
        </span>
        {SECRET_REQUESTS && (
          <a
            className={navLink(location.pathname.startsWith('/request'))}
            href="#/requests"
            title={t('header.buttonRequests')}
          >
            <span className="indicator">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-[18px]"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
                />
              </svg>
              {fulfilledCount > 0 && (
                <span
                  data-testid="requests-badge"
                  className="indicator-item badge badge-error badge-xs px-1.5 font-bold text-error-content"
                  aria-label={t('header.requestsWithCount', {
                    count: fulfilledCount,
                  })}
                >
                  {fulfilledCount > 9 ? '9+' : fulfilledCount}
                </span>
              )}
            </span>
            <span className="hidden sm:inline">
              {t('header.buttonRequests')}
            </span>
          </a>
        )}

        {READ_RECEIPTS && (
          <a
            className={navLink(location.pathname.startsWith('/receipts'))}
            href="#/receipts"
            title={t('header.buttonReceipts')}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="size-[18px]"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              />
            </svg>
            <span className="hidden sm:inline">
              {t('header.buttonReceipts')}
            </span>
          </a>
        )}

        {OIDC_ENABLED &&
          (isAuthenticated ? (
            <form method="POST" action={`${backendDomain}/auth/logout`}>
              <button
                type="submit"
                className={navLink(false)}
                title={t('auth.logout')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="size-[18px]"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"
                  />
                </svg>
                <span className="hidden sm:inline">{t('auth.logout')}</span>
              </button>
            </form>
          ) : (
            <a
              href={`${backendDomain}/auth/login`}
              className={navLink(false)}
              title={t('auth.login')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="size-[18px]"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 15l3-3m0 0-3-3m3 3H3.75"
                />
              </svg>
              <span className="hidden sm:inline">{t('auth.login')}</span>
            </a>
          ))}

        <SettingsMenu />
      </div>
    </header>
  );
}
