import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decryptionOps } from './decryption';
import {
  DecryptionTimeoutError,
  decryptionTimeout,
  runInWorker,
  workerStartTimeout,
} from './decryptInWorker';

vi.mock('./decryption', () => ({
  decryptionOps: { message: vi.fn(), file: vi.fn() },
}));

// Stands in for the browser's Worker; each test decides what it answers.
class FakeWorker {
  static last: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] | undefined;
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
  ready() {
    this.onmessage!({ data: { ready: true } });
  }
  fail() {
    this.onerror!(new ErrorEvent('error', { message: 'Script error' }));
  }
}

beforeEach(() => vi.stubGlobal('Worker', FakeWorker));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('hands a decryption to a module worker once it has loaded', async () => {
  const ciphertext = new ArrayBuffer(8);
  const result = runInWorker('file', [ciphertext, 'key'], [ciphertext]);
  const worker = FakeWorker.last;
  expect(worker.options).toEqual({ type: 'module' });
  expect(worker.posted).toBeUndefined();

  worker.ready();
  expect(worker.posted).toEqual([
    { op: 'file', args: [ciphertext, 'key'] },
    [ciphertext],
  ]);
  const decrypted = { data: new Uint8Array([1]), filename: 'a.txt' };
  worker.onmessage!({ data: { ok: true, result: decrypted } });
  await expect(result).resolves.toBe(decrypted);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(decryptionOps.file).not.toHaveBeenCalled();
});

it('rejects with the error the worker reports', async () => {
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  FakeWorker.last.ready();
  FakeWorker.last.onmessage!({
    data: { ok: false, name: 'Error', message: 'Wrong key' },
  });
  await expect(result).rejects.toThrow('Wrong key');
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
});

it('terminates a worker that takes too long once it has the message', async () => {
  vi.useFakeTimers();
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  const rejected = expect(result).rejects.toBeInstanceOf(
    DecryptionTimeoutError,
  );
  vi.advanceTimersByTime(workerStartTimeout - 1);
  FakeWorker.last.ready();
  vi.advanceTimersByTime(decryptionTimeout - 1);
  expect(FakeWorker.last.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  await rejected;
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  expect(decryptionOps.message).not.toHaveBeenCalled();
});

it('does not decrypt on the page when the worker fails with the message', async () => {
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  FakeWorker.last.ready();
  FakeWorker.last.fail();
  await expect(result).rejects.toThrow('Script error');
  expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  expect(decryptionOps.message).not.toHaveBeenCalled();
});

it('does not decrypt on the page when the worker cannot read its answer', async () => {
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  FakeWorker.last.ready();
  FakeWorker.last.onmessageerror!();
  await expect(result).rejects.toThrow('Decryption failed');
  expect(decryptionOps.message).not.toHaveBeenCalled();
});

it('ignores a worker that loads after the page took over', async () => {
  vi.useFakeTimers();
  const ciphertext = new ArrayBuffer(8);
  const result = runInWorker('file', [ciphertext, 'key'], [ciphertext]);
  const worker = FakeWorker.last;
  vi.advanceTimersByTime(workerStartTimeout);
  // A ready event already queued is dispatched to the current handler.
  worker.onmessage?.({ data: { ready: true } });
  expect(worker.posted).toBeUndefined();
  await result;
  expect(decryptionOps.file).toHaveBeenCalledWith(ciphertext, 'key');
});

it.each([
  [
    'cannot be constructed',
    () =>
      vi.stubGlobal('Worker', function () {
        throw new DOMException('Blocked', 'SecurityError');
      }),
    () => {},
  ],
  ['fails to load', () => {}, () => FakeWorker.last.fail()],
  [
    'cannot read its messages',
    () => {},
    () => FakeWorker.last.onmessageerror!(),
  ],
  [
    'does not load in time',
    () => vi.useFakeTimers(),
    () => vi.advanceTimersByTime(workerStartTimeout),
  ],
])('decrypts on the page when the worker %s', async (_, setup, afterStart) => {
  vi.mocked(decryptionOps.message).mockResolvedValue({
    data: 'secret',
    filename: '',
  });
  setup();
  const result = runInWorker('message', ['ciphertext', 'key', 'utf8']);
  afterStart();
  await expect(result).resolves.toEqual({ data: 'secret', filename: '' });
  expect(decryptionOps.message).toHaveBeenCalledWith(
    'ciphertext',
    'key',
    'utf8',
  );
});
