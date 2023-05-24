const { i18n } = require('./next-i18next.config');
const nextSafe = require('next-safe');

const isDev = process.env.NODE_ENV !== 'production';

module.exports = {
  i18n,
  reactStrictMode: true,
  output: 'standalone',

  async headers() {
    return [
      {
        // Apply these headers to all routes in your application.
        source: '/:path*',
        headers: nextSafe({ isDev }),
      },
    ];
  },
};
