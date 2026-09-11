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
  ])('resolves browser locale %s to %s', async (browser, expected) => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([browser]);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe(expected);
    expect(i18n.t('upload.encrypting')).not.toBe('Encrypting & uploading...');
  });

  it('preserves a saved Belarusian preference using the old code', async () => {
    localStorage.setItem('i18nextLng', 'by');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    const { default: i18n } = await import('./i18n');
    expect(i18n.resolvedLanguage).toBe('be');
  });
});
