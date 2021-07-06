import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';


import Backend from 'i18next-http-backend';

i18n
  .use(initReactI18next)
  .use(LanguageDetector)
  .use(Backend)
  .init({
    fallbackLng: 'en',
    debug: false,
    detection:{
      order: ['navigator']
    },
    // have a common namespace used around the full app
    ns: ['translations'],
    defaultNS: 'translations',
    backend: {
      loadPath: process.env.PUBLIC_URL + '/locales/{{lng}}.json',
    },

    keySeparator: false, // we use content as keys

    interpolation: {
      escapeValue: false, // not needed for react!!
      formatSeparator: ',',
    },

    appendNamespaceToMissingKey: true,
  });

export default i18n;
