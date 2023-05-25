import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import Backend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';

i18n
  .use(initReactI18next)
  .use(Backend)
  .use(LanguageDetector)
  .init({
    backend: {
      loadPath: process.env.PUBLIC_URL + '/locales/{{lng}}.json',
    },

    fallbackLng: process.env.REACT_APP_FALLBACK_LANGUAGE || 'en',
    debug: false,

    // have a common namespace used around the full app
    ns: ['translations'],
    defaultNS: 'translations',

    interpolation: {
      escapeValue: false, // not needed for react!!
      formatSeparator: ',',
    },

    appendNamespaceToMissingKey: true,
    returnNull: false,
  });

export default i18n;
