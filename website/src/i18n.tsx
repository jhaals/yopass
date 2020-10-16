import i18n from "i18next";
import { initReactI18next } from 'react-i18next';
import detector from "i18next-browser-languagedetector";

import Backend from 'i18next-http-backend';

i18n
  .use(detector)
  .use(Backend)
  .use(initReactI18next)
  .init({
    detection: {order: ['navigator', 'querystring']},
    backend: {
      loadPath: '/yopass/locales/{{lng}}.json'
    },

    fallbackLng: "en",
    debug: true,

    // have a common namespace used around the full app
    ns: ["translations"],
    defaultNS: "translations",

    keySeparator: false, // we use content as keys

    interpolation: {
      escapeValue: false, // not needed for react!!
      formatSeparator: ","
    },

    appendNamespaceToMissingKey: true,

    react: {
      wait: true
    }
});

export default i18n;
