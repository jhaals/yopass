import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translations
import { en, sv, no, de, by, ru, fr, nl, es } from '../locales';

i18n
  .use(initReactI18next)
  .use(LanguageDetector)
  .init({
    resources: {
      en: {
        translation: en,
      },
      sv: {
        translation: sv,
      },
      no: {
        translation: no,
      },
      de: {
        translation: de,
      },
      by: {
        translation: by,
      },
      ru: {
        translation: ru,
      },
      fr: {
        translation: fr,
      },
      nl: {
        translation: nl,
      },
      es: {
        translation: es,
      },
    },
    fallbackLng: 'en',
    debug: false,

    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },

    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: [], // Don't cache auto-detected language
    },
  });

export default i18n;
