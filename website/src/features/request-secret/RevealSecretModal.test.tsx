import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
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
