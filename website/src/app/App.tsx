import { useState, type ReactNode } from 'react';
import CreateSecret from '@features/CreateSecret';
import { Routes, Route, HashRouter, useLocation } from 'react-router-dom';
import { useConfig } from '@shared/hooks/useConfig';
import { useAuth } from '@shared/hooks/useAuth';
import { FlowStepContext, type FlowStep } from '@shared/hooks/useFlowStep';
import Navbar from '@shared/components/Navbar';
import HowItWorks, { FlowStrip } from '@shared/components/HowItWorks';
import Prefetcher from '@features/display-secret/Prefetcher';
import StreamingUpload from '@features/StreamingUpload';
import ReadOnlyLanding from '@features/ReadOnlyLanding';
import LoginRequired from '@features/LoginRequired';
import CreateRequest from '@features/request-secret/CreateRequest';
import RequestList from '@features/request-secret/RequestList';
import ProvideSecret from '@features/request-secret/ProvideSecret';
import ReceiptList from '@features/receipts/ReceiptList';
import { useTranslation } from 'react-i18next';

// Routes outside the share flow (secret requests, receipts) use the whole
// page width; every other screen gets the split layout with the lime panel
// (desktop) or the slim progress strip (mobile).
const fullWidthRoutes = /^\/(request|requests|receipts|r)(\/|$)/;

export default function App() {
  const { PRIVACY_NOTICE_URL, IMPRINT_URL, APP_NAME } = useConfig();
  const { t } = useTranslation();

  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-base-100 text-[14.5px] text-base-content">
      <button
        onClick={() => {
          const main = document.getElementById('main-content');
          main?.focus({ preventScroll: true });
          main?.scrollIntoView({ block: 'start' });
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-content"
      >
        {t('accessibility.skipToContent')}
      </button>
      <HashRouter>
        <Shell
          footer={
            <footer className="pt-10 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-base-content/55">
                {PRIVACY_NOTICE_URL && PRIVACY_NOTICE_URL.trim() && (
                  <>
                    <a
                      href={PRIVACY_NOTICE_URL}
                      className="underline decoration-dotted underline-offset-4 transition-colors hover:text-base-content hover:decoration-solid"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('footer.privacyNotice')}
                    </a>
                    <span aria-hidden="true">•</span>
                  </>
                )}
                {IMPRINT_URL && IMPRINT_URL.trim() && (
                  <>
                    <a
                      href={IMPRINT_URL}
                      className="underline decoration-dotted underline-offset-4 transition-colors hover:text-base-content hover:decoration-solid"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('footer.imprint')}
                    </a>
                    <span aria-hidden="true">•</span>
                  </>
                )}
                <span>
                  &copy; {new Date().getFullYear()}{' '}
                  {APP_NAME ?? t('header.appName')}
                </span>
              </div>
            </footer>
          }
        />
      </HashRouter>
    </div>
  );
}

function Shell({ footer }: { footer: ReactNode }) {
  const {
    DISABLE_UPLOAD,
    READ_ONLY,
    REQUIRE_AUTH,
    SECRET_REQUESTS,
    READ_RECEIPTS,
  } = useConfig();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [step, setStep] = useState<FlowStep>(0);
  const splitLayout = !fullWidthRoutes.test(pathname);

  const [loginUnavailable, setLoginUnavailable] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('login_error')) {
      window.history.replaceState(
        {},
        '',
        window.location.pathname + window.location.hash,
      );
      return true;
    }
    return false;
  });

  // Whether creation pages must show the login gate instead of their content.
  const needsLogin = REQUIRE_AUTH && !authLoading && !isAuthenticated;
  return (
    <FlowStepContext.Provider value={setStep}>
      <Navbar />
      {splitLayout && <FlowStrip step={step} />}
      <div
        className={
          splitLayout
            ? 'grid flex-1 lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_460px]'
            : 'flex flex-1 flex-col'
        }
      >
        <div className="flex min-w-0 flex-col px-[max(1.25rem,env(safe-area-inset-left))] sm:px-10 lg:px-14">
          <div
            id="main-content"
            tabIndex={-1}
            className={`mx-auto flex w-full min-w-0 flex-col gap-6 pt-7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary sm:pt-10 lg:pt-14 ${
              splitLayout ? 'max-w-[680px]' : 'max-w-[880px]'
            }`}
          >
            {loginUnavailable && (
              <div role="alert" className="alert alert-warning">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6 shrink-0 stroke-current"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <span>{t('auth.loginUnavailable')}</span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => setLoginUnavailable(false)}
                  aria-label={t('accessibility.dismiss')}
                >
                  &times;
                </button>
              </div>
            )}
            <Routes>
              <Route
                path="/"
                element={
                  READ_ONLY ? (
                    <ReadOnlyLanding />
                  ) : needsLogin ? (
                    <LoginRequired />
                  ) : (
                    <CreateSecret />
                  )
                }
              />
              {READ_ONLY ? (
                <Route path="/upload" element={<ReadOnlyLanding />} />
              ) : needsLogin ? (
                <Route path="/upload" element={<LoginRequired />} />
              ) : (
                !DISABLE_UPLOAD && (
                  <Route path="/upload" element={<StreamingUpload />} />
                )
              )}
              {SECRET_REQUESTS && (
                <>
                  <Route
                    path="/request"
                    element={needsLogin ? <LoginRequired /> : <CreateRequest />}
                  />
                  <Route path="/requests" element={<RequestList />} />
                  <Route path="/r/:key" element={<ProvideSecret />} />
                  <Route path="/r/:key/:fp" element={<ProvideSecret />} />
                </>
              )}
              {READ_RECEIPTS && (
                <Route path="/receipts" element={<ReceiptList />} />
              )}
              <Route path="/:format/:key/:password" element={<Prefetcher />} />
              <Route path="/:format/:key" element={<Prefetcher />} />
            </Routes>
          </div>
          <div
            className={`mx-auto mt-auto w-full ${splitLayout ? 'max-w-[680px]' : 'max-w-[880px]'}`}
          >
            {footer}
          </div>
        </div>
        {splitLayout && <HowItWorks step={step} />}
      </div>
    </FlowStepContext.Provider>
  );
}
