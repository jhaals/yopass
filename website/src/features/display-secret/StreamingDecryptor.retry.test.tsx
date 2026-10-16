import { Blob as NodeBlob } from 'node:buffer';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { downloadUrl } from '@shared/lib/download';
import StreamingDecryptor from './StreamingDecryptor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@shared/hooks/useConfig', () => ({
  useConfig: () => ({ OIDC_ENABLED: false }),
}));
vi.mock('@shared/lib/download', () => ({ downloadUrl: vi.fn() }));

const ciphertext = 'complete encrypted file bytes';
let root: Root;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useNavigate>;
let downloaded: Blob | undefined;
const fetchMock = vi.fn<typeof fetch>();

// Consume every attempt's stream, like OpenPGP does, to catch reuse of a spent stream.
vi.mock('openpgp', () => ({
  enums: { aead: { gcm: 3 } },
  readMessage: vi.fn(
    async ({
      binaryMessage,
    }: {
      binaryMessage: ReadableStream<Uint8Array>;
    }) => ({
      ciphertext: await new Response(binaryMessage).text(),
    }),
  ),
  decrypt: vi.fn(
    async ({
      message,
      passwords,
    }: {
      message: { ciphertext: string };
      passwords: string;
    }) => {
      expect(message.ciphertext).toBe('complete encrypted file bytes');
      if (passwords !== 'correct-key') throw new Error('Wrong key');
      return {
        data: new Response('one-time file contents').body,
        filename: 'report.txt',
      };
    },
  ),
}));

function Harness() {
  const { key } = useParams();
  const routerNavigate = useNavigate();
  useEffect(() => {
    navigate = routerNavigate;
  }, [routerNavigate]);
  return <StreamingDecryptor key={key} secretKey={key!} />;
}

async function render(path = '/f/file-id/wrong-key') {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/f/:key/:password?" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

async function waitForWrongKey() {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain(
      'display.errorInvalidPasswordDetailed',
    );
  });
}

async function enterKey(key: string) {
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, key);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function expectDownload() {
  for (let attempt = 0; attempt < 100 && !downloaded; attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
  expect(downloadUrl).toHaveBeenCalledWith('blob:decrypted', 'report.txt');
  expect(await downloaded!.text()).toBe('one-time file contents');
}

beforeEach(() => {
  vi.clearAllMocks();
  downloaded = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Blob', NodeBlob);
  fetchMock
    .mockReset()
    .mockResolvedValueOnce(new Response(ciphertext))
    .mockImplementation(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => {
        downloaded = blob;
        return 'blob:decrypted';
      }),
      revokeObjectURL: vi.fn(),
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('reuses one-time ciphertext after multiple incorrect keys', async () => {
  await render();
  await waitForWrongKey();
  await enterKey('another-wrong-key');
  await waitForWrongKey();
  await enterKey('correct-key');
  await expectDownload();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('decrypts the retained file when the URL key is corrected', async () => {
  await render();
  await waitForWrongKey();
  await act(async () => navigate('/f/file-id/correct-key'));
  await expectDownload();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('uses a corrected URL key after an in-flight download finishes', async () => {
  let resolve!: (response: Response) => void;
  fetchMock.mockReset().mockReturnValueOnce(
    new Promise(done => {
      resolve = done;
    }),
  );
  await render();
  await act(async () => navigate('/f/file-id/correct-key'));
  await act(async () => resolve(new Response(ciphertext)));
  await expectDownload();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('does not reuse ciphertext for a different file ID', async () => {
  await render();
  await waitForWrongKey();
  await act(async () => navigate('/f/other-id/correct-key'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe('/file/other-id');
  expect(downloadUrl).not.toHaveBeenCalled();
});

it('retries fetching after a transport failure', async () => {
  fetchMock
    .mockReset()
    .mockRejectedValueOnce(new Error('network failure'))
    .mockResolvedValueOnce(new Response(ciphertext));
  await render('/f/file-id/correct-key');
  expect(container.textContent).toContain('display.downloadFailedTitle');
  await act(async () => container.querySelector('button')!.click());
  await expectDownload();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
