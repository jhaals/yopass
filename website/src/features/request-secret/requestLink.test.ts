import { describe, expect, it } from 'vitest';

import { requestLink, shortFingerprint } from './requestLink';

describe('shortFingerprint', () => {
  it('returns the last 16 characters lowercased', () => {
    expect(shortFingerprint('ABCDEF1234567890ABCDEF1234567890')).toBe(
      'abcdef1234567890',
    );
  });

  it('returns short fingerprints whole', () => {
    expect(shortFingerprint('ABC')).toBe('abc');
  });
});

describe('requestLink', () => {
  it('builds the link from the configured public URL', () => {
    expect(requestLink('https://yopass.example.com', 'id123', 'fp456')).toBe(
      'https://yopass.example.com/#/r/id123/fp456',
    );
  });

  it('strips a trailing slash from the public URL', () => {
    expect(requestLink('https://yopass.example.com/', 'id123', 'fp456')).toBe(
      'https://yopass.example.com/#/r/id123/fp456',
    );
  });

  it('falls back to the window origin when no public URL is configured', () => {
    expect(requestLink(undefined, 'id123', 'fp456')).toBe(
      `${window.location.origin}/#/r/id123/fp456`,
    );
    expect(requestLink('', 'id123', 'fp456')).toBe(
      `${window.location.origin}/#/r/id123/fp456`,
    );
  });
});
