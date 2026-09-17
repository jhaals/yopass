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

  it('supplies defaults for older servers', () => {
    expect(parseConfig({})).toMatchObject(defaultConfig);
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
