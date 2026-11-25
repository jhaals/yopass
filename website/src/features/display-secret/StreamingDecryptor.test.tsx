import { Blob as NodeBlob } from 'node:buffer';
import { decrypt, readMessage, Signature } from 'openpgp';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DecryptionTimeoutError } from '@shared/lib/decryptInWorker';
import StreamingDecryptor from './StreamingDecryptor';

vi.mock('react-router-dom', () => ({ useParams: () => ({ password: 'key' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/hooks/useConfig', () => ({
  useConfig: () => ({ OIDC_ENABLED: false }),
}));
vi.mock('openpgp', () => ({
  enums: { aead: { gcm: 3 }, packet: { symEncryptedSessionKey: 3 } },
  PacketList: class {},
  Signature: class {},
  readMessage: vi
    .fn()
    .mockResolvedValue({ packets: { filterByTag: () => [] } }),
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
// Run the worker's decryption in-process; jsdom has no Worker.
vi.mock('@shared/lib/decryptInWorker', async importOriginal => {
  const { decryptionOps } = await import('@shared/lib/decryption');
  return {
    ...(await importOriginal<object>()),
    runInWorker: (op: 'file', args: [ArrayBuffer, string]) =>
      decryptionOps[op](...args),
  };
});
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
        // A stream lets the sender's packet framing set the work per byte.
        binaryMessage: expect.any(Uint8Array),
        config: expect.objectContaining({
          maxDecompressedMessageSize: 1 << 20,
        }),
      }),
    );
    expect(decrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        signature: expect.any(Signature),
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

it.each([
  [new DecryptionTimeoutError(), 'display.errorDecryptTimeout'],
  [new Error('Wrong key'), 'display.errorInvalidPasswordDetailed'],
])('tells a timeout from a wrong key: %s', async (error, message) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ciphertext')));
  vi.mocked(decrypt).mockRejectedValueOnce(error);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<StreamingDecryptor secretKey="file-id" />);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          message,
        ),
      );
    });
  } finally {
    await act(async () => root.unmount());
  }
});
