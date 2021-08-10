# Yopass website

[![Build Status](https://travis-ci.com/yopass/website.svg?branch=master)](https://travis-ci.com/yopass/website)

The UI component for [yopass](https://github.com/3lvia/onetime-yopass)

## Local Development

```bash
yarn
REACT_APP_BACKEND_URL='http://localhost:1337' yarn start
```

## Production Build

```bash
yarn install
PUBLIC_URL='https://my-domain.com' REACT_APP_BACKEND_URL='http://api.my-domain.com' yarn build
```

Upload contents of `build/` to your CDN or hosting provider of choice, be it S3, Netlify or GCS.

## Extra Packages

```bash
yarn add \
    oidc-client \
    redux \
    redux-oidc \
    webfontloader \
    --no-progress
```

## Environment Variables

Create a `.env` file in the root of the project.

```sh
REACT_APP_ELVID_AUTHORITY='https://elvid.test-elvia.io/'
REACT_APP_ELVID_CLIENT_ID='00000000-0000-4000-8000-000000000000'
REACT_APP_ELVID_REDIRECT_URI='http://localhost:3000/auth/signin'
REACT_APP_ELVID_SCOPE=''
REACT_APP_VAULT_ADDR='https://vault.test-elvia.io/'
REACT_APP_VAULT_ROLE_ID=''
REACT_APP_ONETIME_URL='https://onetime.dev-elvia.io/'
REACT_APP_ONETIME_API_URL='https://onetime.dev-elvia.io/'
```
