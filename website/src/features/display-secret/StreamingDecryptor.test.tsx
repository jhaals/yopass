import { Blob as NodeBlob } from 'node:buffer';
import { decrypt, readMessage } from 'openpgp';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import StreamingDecryptor from './StreamingDecryptor';

vi.mock('react-router-dom', () => ({ useParams: () => ({ password: 'key' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/hooks/useConfig', () => ({
  useConfig: () => ({ OIDC_ENABLED: false }),
}));
vi.mock('openpgp', () => ({
  enums: { aead: { gcm: 3 } },
  readMessage: vi.fn().mockResolvedValue({}),
  decrypt: vi.fn().mockImplementation(async () => ({
    data: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('<!doctype html><script>alert(1)</script>'),
        );
        controller.close();
      },
    }),
    filename: 'page.html',
  })),
}));
vi.mock('@shared/lib/download', () => ({ downloadUrl: vi.fn() }));
vi.mock('./FileDownloadedCard', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

it('keeps decrypted HTML opaque in the re-download link', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ciphertext')));
  const create = vi.fn().mockReturnValue('blob:opaque');
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<StreamingDecryptor secretKey="file-id" />);
    });
    await act(async () => {
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    });
    expect(readMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          maxDecompressedMessageSize: 1 << 20,
        }),
      }),
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          maxDecompressedMessageSize: 1 << 20,
        }),
      }),
    );
    expect(create.mock.calls[0][0].type).toBe('application/octet-stream');
    const link = container.querySelector('a')!;
    expect(link.getAttribute('download')).toBe('page.html');
    expect(link.getAttribute('href')).toBe('blob:opaque');
  } finally {
    await act(async () => root.unmount());
  }
});
