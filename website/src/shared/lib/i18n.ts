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
  tr,
  he,
} from '../locales';

// Keep the document in sync: lang drives CSS casing (Turkish i/İ) and screen
// readers, dir flips the layout for Hebrew.
// Use the language actually displayed: an unsupported browser language such as
// ar-SA falls back to English and must not get an RTL layout.
i18n.on('languageChanged', () => {
  const language = i18n.resolvedLanguage || 'en';
  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
});

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
      tr: {
        translation: tr,
      },
      he: {
        translation: he,
      },
    },
    fallbackLng: 'en',
    debug: false,

    interpolation: {
      escapeValue: false, // not needed for react as it escapes by default
    },

    detection: {
      convertDetectedLanguage: detected => {
        const language = detected.split(/[-_]/)[0].toLowerCase();
        // Preserve preferences saved before Belarusian used its standard code.
        if (language === 'by') return 'be';
        // Some clients still report Hebrew with its legacy code.
        if (language === 'iw') return 'he';
        // Browsers report Norwegian as Bokmål (nb) or Nynorsk (nn), not "no".
        return language === 'nb' || language === 'nn' ? 'no' : language;
      },
      order: ['localStorage', 'navigator'],
      caches: [], // Don't cache auto-detected language
    },
  });

export default i18n;
