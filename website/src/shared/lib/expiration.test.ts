import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, parseConfig } from './config';
import {
  dateTimeExpiration,
  expirationSeconds,
  expirationForSubmission,
  initialExpiration,
  localDateTime,
  durationParts,
  validExpiration,
} from './expiration';

describe('expiration policy', () => {
  it('keeps standard choices when custom expiration is disabled', () => {
    for (const value of ['3600', '86400', '604800'])
      expect(validExpiration(value, defaultConfig)).toBe(true);
    for (const value of ['60', '7776000', '3600junk', '0', '-1', '1.5', ''])
      expect(validExpiration(value, defaultConfig)).toBe(false);
  });
  it('accepts inclusive custom bounds and rejects malformed values', () => {
    const config = { ...defaultConfig, ALLOW_CUSTOM_EXPIRATION: true };
    for (const value of ['60', '61', '2592001', '7776000'])
      expect(validExpiration(value, config)).toBe(true);
    for (const value of ['59', '7776001', 'Infinity', '1e3', '2147483648'])
      expect(validExpiration(value, config)).toBe(false);
    expect(
      validExpiration('60', { ...config, FORCE_EXPIRATION: 7776000 }),
    ).toBe(false);
  });
  it('parses custom defaults and forced durations only within enabled bounds', () => {
    const config = parseConfig({
      ALLOW_CUSTOM_EXPIRATION: true,
      MIN_EXPIRATION: 120,
      MAX_EXPIRATION: 7776000,
      DEFAULT_EXPIRY: 61,
      FORCE_EXPIRATION: 7776000,
    });
    expect(config.DEFAULT_EXPIRY).toBeUndefined();
    expect(config.FORCE_EXPIRATION).toBe(7776000);
    expect(
      parseConfig({ ALLOW_CUSTOM_EXPIRATION: true, DEFAULT_EXPIRY: 3888000 })
        .DEFAULT_EXPIRY,
    ).toBe(3888000);
    expect(() =>
      parseConfig({ MIN_EXPIRATION: 100, MAX_EXPIRATION: 60 }),
    ).toThrow('Invalid expiration bounds');
  });
  it('represents durations exactly, including custom defaults in seconds', () => {
    expect(durationParts(7776000)).toEqual({ amount: '90', unit: 86400 });
    expect(durationParts(61)).toEqual({ amount: '61', unit: 1 });
  });
});

describe('date and time expiration', () => {
  const now = new Date('2026-10-05T10:00:00Z').getTime();
  const config = { ...defaultConfig, ALLOW_CUSTOM_EXPIRATION: true };
  it('preserves deadlines and counts elapsed editing time', () => {
    const selected = dateTimeExpiration(localDateTime(now + 86400000));
    expect(expirationSeconds(selected, now)).toBe(86400);
    expect(expirationSeconds(selected, now + 600000)).toBe(85800);
    expect(validExpiration(selected, config, now)).toBe(true);
    expect(validExpiration(selected, defaultConfig, now)).toBe(false);
  });
  it('rejects invalid dates and bounds, including deadlines which become too soon', () => {
    for (const value of [
      '',
      '2026-02-30T12:00',
      '2026-13-01T12:00',
      '2026-10-05T25:00',
      '2026-10-05',
    ])
      expect(dateTimeExpiration(value)).toBe('');
    for (const seconds of [-1, 0, 59, 7776001])
      expect(validExpiration(`at:${now + seconds * 1000}`, config, now)).toBe(
        false,
      );
    for (const seconds of [60, 7776000])
      expect(validExpiration(`at:${now + seconds * 1000}`, config, now)).toBe(
        true,
      );
    expect(validExpiration(`at:${now + 60000}`, config, now + 1000)).toBe(
      false,
    );
  });
  it('initializes custom defaults as deadlines while retaining preset and forced lifetimes', () => {
    expect(initialExpiration({ ...config, DEFAULT_EXPIRY: 7776000 }, now)).toBe(
      `at:${now + 7776000000}`,
    );
    expect(initialExpiration(config, now)).toBe('3600');
    expect(
      initialExpiration({ ...config, FORCE_EXPIRATION: 7776000 }, now),
    ).toBe('7776000');
  });
});

it('keeps narrow expiration policies usable with relative durations', () => {
  const now = new Date('2026-10-05T10:00:30Z').getTime();
  const config = {
    ...defaultConfig,
    ALLOW_CUSTOM_EXPIRATION: true,
    MIN_EXPIRATION: 60,
    MAX_EXPIRATION: 61,
    DEFAULT_EXPIRY: 61,
  };
  const initial = initialExpiration(config, now);
  expect(validExpiration(initial, config, now)).toBe(true);
  expect(initial).toBe('61');
  expect(validExpiration(initial, config, now + 30000)).toBe(true);
  const selectedMinute = localDateTime(now + 61000);
  expect(selectedMinute).toHaveLength(16);
  const selected = dateTimeExpiration(selectedMinute, config, now);
  expect(validExpiration(selected, config, now)).toBe(true);
  expect(expirationSeconds(selected, now)).toBe(60);
});

it('keeps submission validation and conversion consistent across a second boundary', () => {
  const now = new Date('2026-10-05T10:00:00.999Z').getTime();
  const config = { ...defaultConfig, ALLOW_CUSTOM_EXPIRATION: true };
  const deadline = `at:${new Date('2026-10-05T10:01:00Z').getTime()}`;
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(now)
    .mockReturnValue(now + 1);
  try {
    expect(expirationForSubmission(deadline, config)).toBe(60);
    expect(clock).toHaveBeenCalledTimes(1);
    // A submission made after that second boundary must be rejected.
    expect(expirationForSubmission(deadline, config)).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
