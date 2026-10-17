import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from './config';

describe('parseConfig', () => {
  it.each([null, [], 'config', 42])(
    'rejects a non-object response: %j',
    value => {
      expect(() => parseConfig(value)).toThrow(
        'Invalid config response format',
      );
    },
  );

  it('only accepts a boolean for existing request draining', () => {
    expect(
      parseConfig({ SECRET_REQUESTS_DRAINING: true }).SECRET_REQUESTS_DRAINING,
    ).toBe(true);
    for (const value of ['true', 1, null, undefined, false]) {
      expect(
        parseConfig({ SECRET_REQUESTS_DRAINING: value })
          .SECRET_REQUESTS_DRAINING,
      ).toBe(false);
    }
  });

  it('supplies defaults for older servers', () => {
    expect(parseConfig({})).toMatchObject(defaultConfig);
  });

  it('only accepts a boolean to disable the one-click link', () => {
    expect(
      parseConfig({ DISABLE_ONE_CLICK_LINK: true }).DISABLE_ONE_CLICK_LINK,
    ).toBe(true);
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(
        parseConfig({ DISABLE_ONE_CLICK_LINK: value }).DISABLE_ONE_CLICK_LINK,
      ).toBe(false);
    }
  });

  it('only accepts a boolean to disable theme switching', () => {
    expect(parseConfig({ NO_THEME_SWITCHER: true }).NO_THEME_SWITCHER).toBe(
      true,
    );
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(parseConfig({ NO_THEME_SWITCHER: value }).NO_THEME_SWITCHER).toBe(
        false,
      );
    }
  });

  it('only accepts a boolean to hide the application name', () => {
    expect(parseConfig({ HIDE_APP_NAME: true }).HIDE_APP_NAME).toBe(true);
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(parseConfig({ HIDE_APP_NAME: value }).HIDE_APP_NAME).toBe(false);
    }
  });

  it('preserves configurable checkbox defaults and rejects non-booleans', () => {
    expect(
      parseConfig({
        DEFAULT_ONETIME_SECRETS: false,
        DEFAULT_READ_RECEIPT: true,
      }),
    ).toMatchObject({
      DEFAULT_ONETIME_SECRETS: false,
      DEFAULT_READ_RECEIPT: true,
    });
    expect(
      parseConfig({
        DEFAULT_ONETIME_SECRETS: 'false',
        DEFAULT_READ_RECEIPT: 'true',
      }),
    ).toMatchObject({
      DEFAULT_ONETIME_SECRETS: true,
      DEFAULT_READ_RECEIPT: false,
    });
  });

  it('rejects invalid optional field types and unsupported expirations', () => {
    const config = parseConfig({
      READ_ONLY: 'false',
      MAX_FILE_SIZE: {},
      MAX_REQUEST_FILE_SIZE: 1024,
      DEFAULT_EXPIRY: '3600',
      FORCE_EXPIRATION: 123,
      PRIVACY_NOTICE_URL: [],
      IMPRINT_URL: false,
    });
    expect(config.READ_ONLY).toBe(false);
    for (const key of [
      'MAX_FILE_SIZE',
      'MAX_REQUEST_FILE_SIZE',
      'DEFAULT_EXPIRY',
      'FORCE_EXPIRATION',
      'PRIVACY_NOTICE_URL',
      'IMPRINT_URL',
    ] as const) {
      expect(config[key]).toBeUndefined();
    }
  });

  it('keeps supported values and filters unsafe custom theme entries', () => {
    const config = parseConfig({
      DEFAULT_EXPIRY: 86400,
      FORCE_EXPIRATION: 604800,
      THEME_CUSTOM_LIGHT: {
        '--color-primary': 'red',
        color: 'blue',
        '--injection': 'red;}body{color:red',
      },
    });
    expect(config.DEFAULT_EXPIRY).toBe(86400);
    expect(config.FORCE_EXPIRATION).toBe(604800);
    expect(config.THEME_CUSTOM_LIGHT).toEqual({ '--color-primary': 'red' });
  });
});
