import { useState, useEffect } from 'react';
import {
  getInitialLogicalTheme,
  logicalToDaisyTheme,
  THEME_STORAGE_KEY,
  type LogicalTheme,
} from '../theme/theme';
import { useConfig } from '../hooks/useConfig';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

export default function Navbar() {
  const [mode, setMode] = useState<LogicalTheme>(getInitialLogicalTheme);
  const { DISABLE_UPLOAD, NO_LANGUAGE_SWITCHER } = useConfig();
  const { t } = useTranslation();
  const location = useLocation();
  useEffect(() => {
    const daisy = logicalToDaisyTheme(mode);
    document.documentElement.setAttribute('data-theme', daisy);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      void 0;
    }
  }, [mode]);

  const toggleTheme = () => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  };

  return (
    <nav className="bg-base-100 border-b border-base-300 shadow-sm">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <a
              className="flex items-center text-xl font-semibold text-base-content hover:text-primary transition-colors duration-200 px-2 py-1 rounded-lg hover:bg-base-200"
              href="/"
            >
              <img
                src="/yopass.svg"
                alt="Yopass logo"
                className="h-8 w-8 mr-3"
              />
              {t('header.appName')}
            </a>
          </div>
          <div className="flex items-center gap-2">
            {!DISABLE_UPLOAD && location.pathname === '/upload' ? (
              <a
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-base-content hover:text-primary hover:bg-base-200 rounded-lg transition-all duration-200"
                href="#/"
                title={t('header.buttonText')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                  />
                </svg>
                {t('header.buttonText')}
              </a>
            ) : (
              !DISABLE_UPLOAD && (
                <a
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-base-content hover:text-primary hover:bg-base-200 rounded-lg transition-all duration-200"
                  href="#/upload"
                  title={t('header.buttonUpload')}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-5 h-5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                    />
                  </svg>
                  {t('header.buttonUpload')}
                </a>
              )
            )}

            {!NO_LANGUAGE_SWITCHER && <LanguageSwitcher />}

            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-base-200 transition-all duration-200 text-base-content hover:text-primary"
              title={
                mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
              }
            >
              {mode === 'dark' ? (
                <svg
                  className="w-5 h-5"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-5 h-5 fill-current"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                >
                  <path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}
