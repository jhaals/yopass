import { readMessage, decrypt } from 'openpgp';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { backendDomain } from '@shared/lib/api';
import EnterDecryptionKey from './EnterDecryptionKey';

export default function StreamingDecryptor({
  secretKey,
}: {
  secretKey: string;
}) {
  const { t } = useTranslation();
  const { password: paramsPassword } = useParams();
  const [password, setPassword] = useState(() => paramsPassword ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);
  const [filename, setFilename] = useState('download');
  const [progress, setProgress] = useState<number | null>(null);

  async function handleDecrypt(pw: string) {
    setPassword(pw);
    setLoading(true);
    setError(false);
    setProgress(0);

    try {
      // Fetch the encrypted binary stream
      const response = await fetch(`${backendDomain}/file/${secretKey}`, {
        headers: { Accept: 'application/octet-stream' },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch file');
      }

      const serverFilename = response.headers.get('X-Yopass-Filename');
      if (serverFilename) {
        setFilename(serverFilename);
      }

      const contentLength = response.headers.get('Content-Length');
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

      if (!response.body) {
        throw new Error('No response body');
      }

      // Wrap stream with progress tracking
      let downloaded = 0;
      let lastProgress = -1;
      const progressStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          downloaded += chunk.byteLength;
          if (totalSize > 0) {
            const nextProgress = Math.round((downloaded / totalSize) * 100);
            if (nextProgress !== lastProgress) {
              lastProgress = nextProgress;
              setProgress(nextProgress);
            }
          }
          controller.enqueue(chunk);
        },
      });
      const trackedStream = response.body.pipeThrough(progressStream);

      // Decrypt the streaming binary message
      const message = await readMessage({
        binaryMessage: trackedStream as ReadableStream<Uint8Array>,
      });
      const decrypted = await decrypt({
        message,
        passwords: pw,
        format: 'binary',
      });

      // Collect the decrypted stream into a Blob for download
      const blob = await new Response(
        decrypted.data as ReadableStream<Uint8Array>,
      ).blob();

      const resolvedFilename =
        (decrypted as unknown as { filename?: string }).filename ||
        serverFilename ||
        'download';
      setFilename(resolvedFilename);

      // Trigger download
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedFilename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);

      setDone(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  // Auto-decrypt if password is in the URL
  const decryptedRef = useRef(false);
  useEffect(() => {
    if (paramsPassword && !decryptedRef.current) {
      decryptedRef.current = true;
      handleDecrypt(paramsPassword);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-base-content/70">
        <svg
          className="animate-spin h-8 w-8 text-primary"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          ></path>
        </svg>
        <p className="mt-4 text-lg font-medium">
          {t('display.decryptingMessage')}
        </p>
        {progress !== null && (
          <div className="w-64 mt-4">
            <progress
              className="progress progress-primary w-full"
              value={progress}
              max="100"
            />
            <p className="text-sm text-center mt-1">{progress}%</p>
          </div>
        )}
      </div>
    );
  }

  if (error || (!done && !password)) {
    return (
      <EnterDecryptionKey setPassword={handleDecrypt} errorMessage={error} />
    );
  }

  if (done) {
    return (
      <>
        <div className="flex items-center mb-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            className="h-8 w-8 text-success mr-2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"
            />
          </svg>
          <h2 className="text-3xl font-bold">{t('secret.titleFile')}</h2>
        </div>
        <p className="mb-6 text-base-content/70">{t('secret.subtitleFile')}</p>
        <div className="mb-6">
          <div className="bg-base-200 border border-base-300 rounded-xl p-6">
            <div className="flex items-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="h-6 w-6 mr-2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25"
                />
              </svg>
              <span className="text-lg">
                {t('secret.fileDownloaded')}: <strong>{filename}</strong>
              </span>
            </div>
          </div>
        </div>
      </>
    );
  }

  return null;
}
