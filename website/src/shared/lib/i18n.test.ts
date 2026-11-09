import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('language detection', () => {
  it.each([
    ['be-BY', 'be'],
    ['da-DK', 'da'],
    ['pt-BR', 'pt'],
    ['pt-PT', 'pt'],
    ['ro-RO', 'ro'],
    ['tr-TR', 'tr'],
    ['nb-NO', 'no'],
    ['nb', 'no'],
    ['nn-NO', 'no'],
    ['no-NO', 'no'],
    ['he-IL', 'he'],
    ['iw-IL', 'he'],
  ])('resolves browser locale %s to %s', async (browser, expected) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([browser]);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe(expected);
    expect(i18n.t('upload.encrypting')).not.toBe('Encrypting & uploading...');
  });

  it.each([
    ['he-IL', 'he', 'rtl'],
    ['tr-TR', 'tr', 'ltr'],
    ['ar-SA', 'en', 'ltr'],
    ['zh-CN', 'en', 'ltr'],
  ])('sets lang and dir on the document for %s', async (browser, lang, dir) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([browser]);
    await import('./i18n');
    expect(document.documentElement.lang).toBe(lang);
    expect(document.documentElement.dir).toBe(dir);
  });

  it('prefers the first listed language over a later exact match', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['sv-SE', 'en']);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe('sv');
  });

  it('ignores the static html lang attribute', async () => {
    document.documentElement.lang = 'en';
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['sv-SE']);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe('sv');
  });

  it('uses English when the first browser language is unsupported', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['ar-SA', 'he-IL']);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('preserves a saved Belarusian preference using the old code', async () => {
    localStorage.setItem('i18nextLng', 'by');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe('be');
  });
});

describe('plural forms', () => {
  it.each([
    ['en', 1, '1 secret waiting to be collected'],
    ['en', 2, '2 secrets waiting to be collected'],
    ['ru', 1, '1 секрет ожидает получения'],
    ['ru', 2, '2 секрета ожидают получения'],
    ['ru', 5, '5 секретов ожидают получения'],
    ['ru', 21, '21 секрет ожидает получения'],
    ['he', 2, 'שני סודות ממתינים לאיסוף'],
  ])('%s renders count %i', async (language, count, expected) => {
    const { default: i18n } = await import('./i18n');
    expect(i18n.t('header.requestsWithCount', { lng: language, count })).toBe(
      expected,
    );
  });
});
