import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPIENTS,
  parseRecipients,
  recipientListError,
} from './recipients';

describe('parseRecipients', () => {
  it('returns an empty list for blank input', () => {
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients('   ')).toEqual([]);
  });

  it('splits on commas, semicolons and whitespace', () => {
    expect(parseRecipients('a@b.com, c@d.com;e@f.com g@h.com')).toEqual([
      'a@b.com',
      'c@d.com',
      'e@f.com',
      'g@h.com',
    ]);
  });

  it('drops blanks and preserves order', () => {
    expect(parseRecipients(' , a@b.com ,, c@d.com , ')).toEqual([
      'a@b.com',
      'c@d.com',
    ]);
  });

  it('drops case-insensitive duplicates, keeping the first spelling', () => {
    expect(parseRecipients('Alice@Example.com, alice@example.com')).toEqual([
      'Alice@Example.com',
    ]);
  });
});

describe('recipientListError', () => {
  it('accepts an empty list', () => {
    expect(recipientListError('')).toBeNull();
  });

  it('accepts well-formed addresses', () => {
    expect(recipientListError('alice@example.com, bob@sub.example.co.uk')).toBe(
      null,
    );
  });

  it('rejects a malformed address', () => {
    expect(recipientListError('alice@example.com, nope')).toBe(
      'verification.invalidRecipient',
    );
  });

  it('rejects more than the maximum', () => {
    const many = Array.from(
      { length: MAX_RECIPIENTS + 1 },
      (_, i) => `user${i}@example.com`,
    ).join(',');
    expect(recipientListError(many)).toBe('verification.tooManyRecipients');
  });
});
