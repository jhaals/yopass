import { runDecryptionOp, type DecryptionRequest } from './decryption';

self.onmessage = async ({ data }: MessageEvent<DecryptionRequest>) => {
  const [response, transfer] = await runDecryptionOp(data);
  self.postMessage(response, { transfer });
};
