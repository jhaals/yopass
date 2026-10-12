import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('uses the Clipboard API when available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  expect(await copyText('link')).toBe(true);
  expect(writeText).toHaveBeenCalledWith('link');
});

it('falls back to the copy command without the Clipboard API', async () => {
  vi.stubGlobal('navigator', {});
  const exec = vi.fn().mockReturnValue(true);
  document.execCommand = exec;
  expect(await copyText('link')).toBe(true);
  expect(exec).toHaveBeenCalledWith('copy');
  expect(document.querySelector('textarea')).toBeNull();
});

it('falls back when the Clipboard API rejects, and reports failure', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  document.execCommand = vi.fn().mockReturnValue(false);
  expect(await copyText('link')).toBe(false);
});
