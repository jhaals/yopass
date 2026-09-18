import { afterEach, expect, it, vi } from 'vitest';
import { randomInt, randomString } from './random';

afterEach(() => vi.restoreAllMocks());

it('rejects biased bytes before choosing a value in the requested range', () => {
  const values = [255, 248, 247];
  const random = vi
    .spyOn(window.crypto, 'getRandomValues')
    .mockImplementation(array => {
      (array as Uint8Array)[0] = values.shift()!;
      return array;
    });
  expect(randomInt(10, 72)).toBe(71);
  expect(random).toHaveBeenCalledTimes(3);
});

it('generates 22-character keys using the full supported alphabet', () => {
  let next = 0;
  vi.spyOn(window.crypto, 'getRandomValues').mockImplementation(array => {
    (array as Uint8Array)[0] = next++ % 62;
    return array;
  });
  const keys = [randomString(), randomString(), randomString()];
  expect(keys.every(key => /^[A-Za-z0-9]{22}$/.test(key))).toBe(true);
  expect(keys.join('')).toContain(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  );
});
