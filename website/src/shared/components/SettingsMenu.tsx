import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig } from '@shared/hooks/useConfig';
import { useTheme } from '@shared/theme/ThemeProvider';
import { useDateFormat } from '@shared/hooks/useDateFormat';
import { formatDateTime } from '@shared/lib/dateFormat';

const languages = [
  { code: 'en', name: 'English' },
  { code: 'sv', name: 'Svenska' },
  { code: 'no', name: 'Norsk' },
  { code: 'de', name: 'Deutsch' },
  { code: 'cs', name: 'Czech' },
  { code: 'pl', name: 'Polish' },
  { code: 'ru', name: 'Русский' },
  { code: 'by', name: 'Беларускі' },
  { code: 'fr', name: 'Français' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'es', name: 'Español' },
  { code: 'it', name: 'Italiano' },
  { code: 'ja', name: '日本語' },
];

// Cogwheel dropdown bundling the app-wide display settings: language,
// light/dark theme, and date format. All are persisted in the browser.
export default function SettingsMenu() {
  const { t, i18n } = useTranslation();
  const { NO_LANGUAGE_SWITCHER } = useConfig();
  const { mode, setTheme } = useTheme();
  const [dateFormat, setDateFormat] = useDateFormat();
  const [isOpen, setIsOpen] = useState(false);
  // Captured when the menu opens so the date format preview reflects "now"
  // without calling Date.now() during render.
  const [previewTime, setPreviewTime] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function toggleOpen() {
    setPreviewTime(Math.floor(Date.now() / 1000));
    setIsOpen(prev => !prev);
  }

  function handleLanguageChange(languageCode: string) {
    i18n.changeLanguage(languageCode);
    // Only store language preference when user explicitly selects it
    localStorage.setItem('i18nextLng', languageCode);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={toggleOpen}
        aria-expanded={isOpen}
        aria-controls="settings-menu"
        aria-label={t('settings.title')}
        title={t('settings.title')}
        data-testid="settings-menu-button"
        className="p-2 rounded-md hover:bg-base-200 transition-all duration-200 text-base-content hover:text-primary cursor-pointer"
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
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </svg>
      </button>
      {isOpen && (
        <div
          id="settings-menu"
          role="menu"
          className="absolute end-0 mt-1 bg-base-100 border border-base-300 rounded-xl z-[1] w-64 p-4 shadow-lg space-y-4"
        >
          {!NO_LANGUAGE_SWITCHER && (
            <div>
              <label
                className="block text-xs font-semibold uppercase tracking-wide text-base-content/60 mb-2"
                htmlFor="settings-language"
              >
                {t('settings.language')}
              </label>
              <select
                id="settings-language"
                aria-label={t('settings.language')}
                className="select select-bordered select-sm w-full"
                value={i18n.language}
                onChange={e => handleLanguageChange(e.target.value)}
              >
                {languages.map(language => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
              {t('settings.theme')}
            </span>
            {/* daisyUI toggle with icons inside: sun when light, moon when dark */}
            <label
              className="toggle text-base-content"
              data-testid="theme-toggle"
            >
              <input
                type="checkbox"
                checked={mode === 'dark'}
                onChange={e => setTheme(e.target.checked ? 'dark' : 'light')}
                aria-label={t('settings.darkModeToggle')}
              />
              <svg
                aria-label="sun"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
              >
                <g
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeWidth="2"
                  fill="none"
                  stroke="currentColor"
                >
                  <circle cx="12" cy="12" r="4"></circle>
                  <path d="M12 2v2"></path>
                  <path d="M12 20v2"></path>
                  <path d="m4.93 4.93 1.41 1.41"></path>
                  <path d="m17.66 17.66 1.41 1.41"></path>
                  <path d="M2 12h2"></path>
                  <path d="M20 12h2"></path>
                  <path d="m6.34 17.66-1.41 1.41"></path>
                  <path d="m19.07 4.93-1.41 1.41"></path>
                </g>
              </svg>
              <svg
                aria-label="moon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
              >
                <g
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeWidth="2"
                  fill="none"
                  stroke="currentColor"
                >
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
                </g>
              </svg>
            </label>
          </div>
          <div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
                {t('dateFormat.label')}
              </span>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-sm font-medium">
                  {t('dateFormat.iso')}
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={dateFormat === 'iso'}
                  onChange={e =>
                    setDateFormat(e.target.checked ? 'iso' : 'locale')
                  }
                  aria-label={t('dateFormat.isoToggle')}
                  data-testid="date-format-toggle"
                />
              </label>
            </div>
            {/* Live preview of how dates will be rendered */}
            <div
              className="text-xs text-base-content/60 mt-1 text-right font-mono"
              data-testid="date-format-preview"
            >
              {formatDateTime(previewTime, dateFormat)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
