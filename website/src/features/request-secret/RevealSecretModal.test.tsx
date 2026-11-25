import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { maxShownCharacters } from '@shared/lib/shownText';
import RevealSecretModal from './RevealSecretModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it.each([true, false])(
  'undecrypted=%s keeps the text direction',
  undecrypted => {
    const html = renderToStaticMarkup(
      <RevealSecretModal
        secret="-----BEGIN PGP MESSAGE-----"
        undecrypted={undecrypted}
        copied={false}
        onCopy={() => {}}
        onDownload={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('<pre dir="ltr"');
  },
);

it.each([
  [maxShownCharacters, false],
  [maxShownCharacters + 1, true],
  [1 << 20, true],
])(
  'renders at most the limit of a %i character secret',
  (length, truncated) => {
    const html = renderToStaticMarkup(
      <RevealSecretModal
        secret={'Ω'.repeat(length)}
        copied={false}
        onCopy={() => {}}
        onDownload={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html.match(/Ω/g)?.length).toBe(Math.min(length, maxShownCharacters));
    expect(html.includes('common.textTruncated')).toBe(truncated);
  },
);
