import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from './dateFormat';

afterEach(() => {
  document.documentElement.lang = '';
  vi.restoreAllMocks();
});

describe('formatDateTime', () => {
  it('returns a plain ISO date', () => {
    expect(formatDateTime(0, 'iso')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it.each([
    ['sv', 'en-GB', 'sv-GB'],
    ['en', 'en-GB', 'en-GB'],
    ['en', 'sv-SE', 'en-SE'],
    ['en', 'sv', 'en'],
    ['en', 'en_US', 'en'],
    ['en', '', 'en'],
  ])('formats %s on a %s browser as %s', (lang, browser, locale) => {
    document.documentElement.lang = lang;
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);
    expect(formatDateTime(0, 'locale')).toBe(
      new Date(0).toLocaleString(locale),
    );
  });
});
