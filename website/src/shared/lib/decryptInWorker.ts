import type {
  DecryptionOps,
  DecryptionRequest,
  DecryptionResponse,
} from './decryption';

// Longer than any message Yopass writes takes to decrypt on a slow device.
export const decryptionTimeout = 30_000;

export class DecryptionTimeoutError extends Error {
  constructor() {
    super('Decryption took too long');
    this.name = 'DecryptionTimeoutError';
  }
}

// Runs one decryption in a worker of its own, so that a costly message
// cannot block the page, and terminates it when it takes too long. Buffers
// in transfer move to the worker instead of being copied.
export function runInWorker<K extends keyof DecryptionOps>(
  op: K,
  args: Parameters<DecryptionOps[K]>,
  transfer: Transferable[] = [],
): ReturnType<DecryptionOps[K]> {
  return new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(
      new URL('./decryption.worker.ts', import.meta.url),
      { type: 'module' },
    );
    function settle(done: () => void) {
      clearTimeout(timer);
      worker.terminate();
      done();
    }
    const timer = setTimeout(
      () => settle(() => reject(new DecryptionTimeoutError())),
      decryptionTimeout,
    );
    worker.onmessage = ({ data }: MessageEvent<DecryptionResponse>) =>
      settle(() =>
        data.ok
          ? resolve(data.result)
          : reject(Object.assign(new Error(data.message), { name: data.name })),
      );
    worker.onerror = event => {
      event.preventDefault();
      settle(() => reject(new Error(event.message || 'Decryption failed')));
    };
    worker.onmessageerror = () =>
      settle(() => reject(new Error('Decryption failed')));
    const request: DecryptionRequest = { op, args };
    worker.postMessage(request, transfer);
  }) as ReturnType<DecryptionOps[K]>;
}
