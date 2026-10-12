import { beforeEach, expect, it } from 'vitest';
import { defaultConfig } from './config';
import {
  loadPreferences,
  preferredExpiration,
  saveExpiration,
  savePreferences,
} from './preferences';

beforeEach(() => localStorage.clear());

it('remembers options across loads and merges updates', () => {
  savePreferences({ oneTime: false, generateKey: false });
  savePreferences({ readReceipt: true });
  expect(loadPreferences()).toEqual({
    oneTime: false,
    generateKey: false,
    readReceipt: true,
  });
});

it('ignores corrupt or mistyped stored values', () => {
  localStorage.setItem(
    'urlx-secret-options',
    '{"oneTime":"yes","expiration":5}',
  );
  expect(loadPreferences()).toEqual({});
  localStorage.setItem('urlx-secret-options', 'not json');
  expect(loadPreferences()).toEqual({});
});

it('restores a saved lifetime only while the server accepts it', () => {
  const config = { ...defaultConfig, DEFAULT_EXPIRY: 3600 };
  saveExpiration('at:1999999999999');
  expect(preferredExpiration(config)).toBe('3600');
  saveExpiration('604800');
  expect(preferredExpiration(config)).toBe('604800');
  expect(preferredExpiration({ ...config, FORCE_EXPIRATION: 86400 })).toBe(
    '86400',
  );
  saveExpiration('1234');
  expect(preferredExpiration(config)).toBe('3600');
});
