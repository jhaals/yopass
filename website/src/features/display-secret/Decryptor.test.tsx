import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decryptMessage } from '@shared/lib/crypto';
import { maxShownCharacters } from '@shared/lib/shownText';
import Decryptor from './Decryptor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/lib/crypto', () => ({ decryptMessage: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([
  [maxShownCharacters, false],
  [maxShownCharacters + 1, true],
  [1 << 20, true],
])(
  'renders at most the limit of a %i character secret and copies all of it',
  async (length, truncated) => {
    const secret = 'x'.repeat(length);
    vi.mocked(decryptMessage).mockResolvedValue({
      data: secret,
      signatures: [],
      filename: '',
    });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/s/id/key']}>
          <Routes>
            <Route
              path="/:format/:key/:password"
              element={<Decryptor secret="ciphertext" initialPassword="key" />}
            />
          </Routes>
        </MemoryRouter>,
      );
    });

    const shown = container.querySelector('[data-testid="decrypted-secret"]');
    expect(shown?.textContent?.length).toBe(
      Math.min(length, maxShownCharacters),
    );
    expect(container.querySelector('[role="alert"]') !== null).toBe(truncated);

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="secret.buttonCopyToClipboard"]',
    );
    await act(async () => copy!.click());
    expect(writeText).toHaveBeenCalledWith(secret);
  },
);
