# Yopass website

[![Build Status](https://travis-ci.com/yopass/website.svg?branch=master)](https://travis-ci.com/yopass/website)

The UI component for [yopass](https://github.com/jhaals/yopass)

## Local Development

```bash
REACT_APP_BACKEND_URL='http://localhost:1337' yarn start
```

## Production Build

```bash
PUBLIC_URL='https://my-domain.com' REACT_APP_BACKEND_URL='http://api.my-domain.com' yarn build
```

Upload contents of `build/` to your CDN or hosting provider of choice, be it S3, Netlify or GCS.

## Multilingual Build

The Yopass user interface is shipped in English by default. It is possible to create a custom build that supports multiple languages.
To include an additional language, place a LOCALE.json (for example `de.json`) in `./public/locales/`.
The user interface tries to determine the browser's preferred language by using the following information (in the given order):

- querystring (append ?lng=LANGUAGE to URL)
- cookie (set cookie i18next=LANGUAGE)
- localStorage (set key i18nextLng=LANGUAGE)
- sessionStorage (set key i18nextLng=LANGUAGE)
- navigator (browser language)
- htmlTag (html lang="LANGUAGE")

You can change this list in the i18n options in `./src/i18n.tsx`. Please have a look at https://github.com/i18next/i18next-browser-languageDetector for the details.

If the determined language cannot be found, a fallback language is being used. It defaults to English ("en").
The fallback language can be set at build time using the environment variable REACT_APP_FALLBACK_LANGUAGE.
If you want to change the fallback language, you need to make sure to place a complete language json file under `./public/locales/` containing all keys defined in the original "en.json".

After adding your LOCALE.json file(s) in `./public/locales/`, build the website as usual. Optionally, the environment variable REACT_APP_FALLBACK_LANGUAGE can be set.

```bash
PUBLIC_URL='https://my-domain.com' REACT_APP_BACKEND_URL='http://api.my-domain.com' REACT_APP_FALLBACK_LANGUAGE=en yarn build
```

## Additional options

- `YOPASS_DISABLE_FEATURES_CARDS=1` - Allows disabling Features cards
- `YOPASS_DISABLE_ONE_CLICK_LINK=1` - Allows disabling "One-click link" support
