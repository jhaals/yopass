import { runDecryptionOp, type DecryptionRequest } from './decryption';

self.onmessage = async ({ data }: MessageEvent<DecryptionRequest>) => {
  const [response, transfer] = await runDecryptionOp(data);
  self.postMessage(response, { transfer });
};
// Tells the page that this module and OpenPGP.js have loaded.
self.postMessage({ ready: true });

// In development OpenPGP.js logs every packet it skips, and a message can hold
// hundreds of thousands: that many console calls from a worker crash WebKit.
if (import.meta.env.DEV) console.error = () => {};
