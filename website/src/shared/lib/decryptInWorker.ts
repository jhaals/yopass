import type {
  DecryptionOps,
  DecryptionRequest,
  DecryptionResponse,
} from './decryption';

// Longer than any message Yopass writes takes to decrypt on a slow device.
export const decryptionTimeout = 30_000;
// How long a worker may take to load before decryption runs without one.
export const workerStartTimeout = 10_000;

export class DecryptionTimeoutError extends Error {
  constructor() {
    super('Decryption took too long');
    this.name = 'DecryptionTimeoutError';
  }
}

// The same decryption and limits, on the page's thread.
async function runInPage<K extends keyof DecryptionOps>(
  op: K,
  args: Parameters<DecryptionOps[K]>,
) {
  const { decryptionOps } = await import('./decryption');
  return (decryptionOps[op] as (...args: unknown[]) => Promise<unknown>)(
    ...args,
  );
}

// Runs one decryption in a worker of its own, so that a costly message
// cannot block the page, and terminates it when it takes too long. Buffers
// in transfer move to the worker instead of being copied.
//
// A worker that cannot start (blocked, missing or too slow to load) has not
// seen the message yet, so decryption then runs on the page instead. Once the
// worker is ready its failures are final: falling back after the message was
// handed over would let a hostile message reach the page's thread.
export function runInWorker<K extends keyof DecryptionOps>(
  op: K,
  args: Parameters<DecryptionOps[K]>,
  transfer: Transferable[] = [],
): ReturnType<DecryptionOps[K]> {
  return new Promise<unknown>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(runInPage(op, args));
      return;
    }
    let ready = false;
    let timer = setTimeout(unavailable, workerStartTimeout);
    function settle(done: () => void) {
      clearTimeout(timer);
      // Messages already queued, such as a late ready, must not post the
      // request or detach its buffers.
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      done();
    }
    function unavailable() {
      settle(() => resolve(runInPage(op, args)));
    }
    function failed(message: string) {
      if (ready) settle(() => reject(new Error(message)));
      else unavailable();
    }
    worker.onmessage = ({ data }: MessageEvent<DecryptionResponse>) => {
      // The first message says the worker has loaded.
      if (!ready) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(
          () => settle(() => reject(new DecryptionTimeoutError())),
          decryptionTimeout,
        );
        const request: DecryptionRequest = { op, args };
        worker.postMessage(request, transfer);
        return;
      }
      settle(() =>
        data.ok
          ? resolve(data.result)
          : reject(Object.assign(new Error(data.message), { name: data.name })),
      );
    };
    worker.onerror = event => {
      event.preventDefault();
      failed(event.message || 'Decryption failed');
    };
    worker.onmessageerror = () => failed('Decryption failed');
  }) as ReturnType<DecryptionOps[K]>;
}
