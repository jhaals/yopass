import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translations
import {
  en,
  sv,
  no,
  fi,
  de,
  cs,
  pl,
  be,
  ru,
  fr,
  nl,
  es,
  ja,
  it,
  ro,
  da,
  pt,
} from '../locales';

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
      fi: {
        translation: fi,
      },
      de: {
        translation: de,
      },
      cs: {
        translation: cs,
      },
      pl: {
        translation: pl,
      },
      be: {
        translation: be,
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
      it: {
        translation: it,
      },
      ja: {
        translation: ja,
      },
      ro: {
        translation: ro,
      },
      da: {
        translation: da,
      },
      pt: {
        translation: pt,
      },
    },
    fallbackLng: 'en',
    debug: false,

    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },

    detection: {
      // Preserve preferences saved before Belarusian used its standard code.
      convertDetectedLanguage: language =>
        language === 'by' ? 'be' : language,
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: [], // Don't cache auto-detected language
    },
  });

export default i18n;
