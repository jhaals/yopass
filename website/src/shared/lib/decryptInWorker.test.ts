import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  DecryptionTimeoutError,
  decryptionTimeout,
  runInWorker,
} from './decryptInWorker';

// Stands in for the browser's Worker; each test decides what it answers.
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminate = vi.fn();
  constructor(
    public url: URL,
    public options: WorkerOptions,
  ) {
    FakeWorker.last = this;
  }
  postMessage(...args: unknown[]) {
    this.posted = args;
  }
}

beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('runs a decryption in a module worker and hands over its buffers', async () => {
  const ciphertext = new ArrayBuffer(8);
  const result = runInWorker('file', [ciphertext, 'key'], [ciphertext]);
  const worker = FakeWorker.last;
  expect(worker.options).toEqual({ type: 'module' });
  expect(worker.posted).toEqual([
    { op: 'file', args: [ciphertext, 'key'] },
    [ciphertext],
  ]);

  const decrypted = { data: new Uint8Array([1]), filename: 'a.txt' };
  worker.onmessage!({ data: { ok: true, result: decrypted } });
  await expect(result).resolves.toBe(decrypted);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('rejects with the error the worker reports', async () => {
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  FakeWorker.last.onmessage!({
    data: { ok: false, name: 'Error', message: 'Wrong key' },
  });
  await expect(result).rejects.toThrow('Wrong key');
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});

it('terminates a worker that takes too long', async () => {
  vi.useFakeTimers();
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  const rejected = expect(result).rejects.toBeInstanceOf(
    DecryptionTimeoutError,
  );
  vi.advanceTimersByTime(decryptionTimeout - 1);
  expect(FakeWorker.last.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  await rejected;
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});

it('rejects when the worker fails to run', async () => {
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  FakeWorker.last.onerror!(
    new ErrorEvent('error', { message: 'Script error' }),
  );
  await expect(result).rejects.toThrow('Script error');
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});
