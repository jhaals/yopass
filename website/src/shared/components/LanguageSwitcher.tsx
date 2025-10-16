import { useTranslation } from 'react-i18next';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();

  const languages = [
    { code: 'en', name: 'English' },
    { code: 'sv', name: 'Svenska' },
    { code: 'no', name: 'Norsk' },
    { code: 'de', name: 'Deutsch' },
    { code: 'ru', name: 'Русский' },
    { code: 'by', name: 'Беларускі' },
    { code: 'fr', name: 'Français' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'es', name: 'Español' },
  ];

  function handleLanguageChange(languageCode: string) {
    i18n.changeLanguage(languageCode);
    // Only store language preference when user explicitly selects it
    localStorage.setItem('i18nextLng', languageCode);
  }

  return (
    <div className="dropdown dropdown-end">
      <div
        tabIndex={0}
        role="button"
        className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-base-content hover:text-primary hover:bg-base-200 rounded-lg transition-all duration-200 cursor-pointer"
        title="Change language"
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
            d="m10.5 21 5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 0 1 6-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 0 1-3.827-5.802"
          />
        </svg>
        {languages
          .find(lang => lang.code === i18n.language)
          ?.code.toUpperCase() || 'EN'}
      </div>
      <ul
        tabIndex={0}
        className="dropdown-content menu bg-base-100 border border-base-300 rounded-xl z-[1] w-36 p-2 shadow-lg"
      >
        {languages.map(language => (
          <li key={language.code}>
            <button
              onClick={() => handleLanguageChange(language.code)}
              className={`w-full text-left px-3 py-2 text-sm rounded-lg transition-all duration-200 hover:bg-base-200 ${
                i18n.language === language.code
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-base-content hover:text-primary'
              }`}
            >
              {language.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
