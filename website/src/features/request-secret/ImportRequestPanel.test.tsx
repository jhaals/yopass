import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  exportStoredRequest,
  listStoredRequests,
  saveStoredRequest,
  type StoredRequest,
} from '@shared/lib/requestStore';
import ImportRequestPanel from './ImportRequestPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let container: HTMLDivElement;
const onImported = vi.fn();

const stored: StoredRequest = {
  id: 'req-1',
  label: 'Database password',
  token: 'token',
  publicKey: 'public',
  privateKey: 'private',
  fingerprint: 'fingerprint',
  createdAt: 0,
  expiresAt: 2000000000,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
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

async function importText(json: string) {
  await act(async () => {
    root.render(<ImportRequestPanel onImported={onImported} />);
  });
  const textarea = container.querySelector('textarea')!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )!.set!;
  await act(async () => {
    setValue.call(textarea, json);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('button')!.click());
}

it.each([{ token: 'other-token' }, { privateKey: 'other-private-key' }])(
  'explains why it refuses to replace stored credentials: %j',
  async patch => {
    saveStoredRequest(stored);

    await importText(exportStoredRequest({ ...stored, ...patch }));

    expect(container.textContent).toContain('request.importConflict');
    expect(container.textContent).not.toContain('request.importError');
    expect(onImported).not.toHaveBeenCalled();
    expect(listStoredRequests()).toEqual([stored]);
  },
);

it('imports an export whose credentials match the stored request', async () => {
  saveStoredRequest(stored);

  await importText(exportStoredRequest(stored));

  expect(container.textContent).not.toContain('request.importConflict');
  expect(onImported).toHaveBeenCalledOnce();
});
