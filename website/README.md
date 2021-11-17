# Yopass website

[![Build Status](https://travis-ci.com/yopass/website.svg?branch=master)](https://travis-ci.com/yopass/website)

The UI component for [yopass](https://github.com/3lvia/onetime-yopass)

## Errors

The following issue will occur with Node 17. Use Node `v16.13.0` as the [workaround](https://stackoverflow.com/questions/69693907/error-err-package-path-not-exported-package-subpath-lib-tokenize-is-not-d/69698758#69698758).

```console
$ node --version
v17.1.0
$ REACT_APP_BACKEND_URL='http://localhost:1337' yarn start
yarn run v1.22.10
$ react-scripts start
node:internal/modules/cjs/loader:488
      throw e;
      ^

Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './lib/tokenize' is not defined by "exports" in ${HOME}/github/3lvia/onetime-yopass/website/node_modules/postcss-safe-parser/node_modules/postcss/package.json
    at new NodeError (node:internal/errors:371:5)
    at throwExportsNotFound (node:internal/modules/esm/resolve:416:9)
    at packageExportsResolve (node:internal/modules/esm/resolve:669:3)
    at resolveExports (node:internal/modules/cjs/loader:482:36)
    at Function.Module._findPath (node:internal/modules/cjs/loader:522:31)
    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:919:27)
    at Function.Module._load (node:internal/modules/cjs/loader:778:27)
    at Module.require (node:internal/modules/cjs/loader:999:19)
    at require (node:internal/modules/cjs/helpers:102:18)
    at Object.<anonymous> (${HOME}/github/3lvia/onetime-yopass/website/node_modules/postcss-safe-parser/lib/safe-parser.js:1:17) {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}
```

## Local Playwright Automatic Tests

```bash
# DO NOT COMMIT THIS CHANGE
sed \
    --in-place \
    "s|https://onetime.dev-elvia.io|http://localhost:3000|g" \
    .env.development

export ONETIME_TEST_USER_EMAIL="onetime.testuser@internal.testuser"
export ONETIME_TEST_USER_PASSWORD="0000000000000000000000000000000000000000000000000000000000000000"

yarn \
    && yarn run format \
    && yarn run lint \
    && yarn run playwright-ci
```

## Local Development

- Run Server

```bash
export ONETIME_ELVID_BASE_URL="https://elvid.contoso.io"
export VAULT_ADDR="https://vault.constoso.io"
export GITHUB_PERSONAL_ACCESS_TOKEN_READ_ORG_SCOPE='ghp_000000000000000000000000000000000000' # read-org-scope — read:org
export GITHUB_TOKEN="${GITHUB_PERSONAL_ACCESS_TOKEN_READ_ORG_SCOPE}"
go run ./cmd/yopass-server/
```

- Run Website

```bash
cd website
# DO NOT COMMIT THIS CHANGE
sed \
    --in-place \
    "s|https://onetime.dev-elvia.io|http://localhost:3000|g" \
    .env.development

yarn
REACT_APP_BACKEND_URL='http://localhost:1337' yarn start
```

## Production Build

```bash
yarn install
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
