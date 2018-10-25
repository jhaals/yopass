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

Upload contents of `build/` to your CDN or hosting provider of choice, be it S3, Netflify or GCS.
