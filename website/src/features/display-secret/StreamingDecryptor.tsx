import { readMessage, decrypt } from 'openpgp';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { backendDomain, crossOriginCredentials } from '@shared/lib/api';
import { downloadUrl } from '@shared/lib/download';
import { useConfig } from '@shared/hooks/useConfig';
import AuthRequiredNotice from '@shared/components/AuthRequiredNotice';
import DecryptingSpinner from '@shared/components/DecryptingSpinner';
import { WarningIcon } from '@shared/components/icons';
import EnterDecryptionKey from './EnterDecryptionKey';
import ErrorPage from './ErrorPage';
import FileDownloadedCard from './FileDownloadedCard';

// Which phase of handleDecrypt failed decides the error screen: transport
// problems get a retry page, OpenPGP failures the wrong-key flow.
type DecryptFailure = 'download' | 'decrypt';

export default function StreamingDecryptor({
  secretKey,
}: {
  secretKey: string;
}) {
  const { t } = useTranslation();
  const { OIDC_ENABLED } = useConfig();
  const { password: paramsPassword } = useParams();
  const [password, setPassword] = useState(() => paramsPassword ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DecryptFailure | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [done, setDone] = useState(false);
  const [filename, setFilename] = useState('download');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  // Revoke blob URL on unmount
  const blobUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  async function handleDecrypt(pw: string) {
    setPassword(pw);
    setLoading(true);
    setError(null);
    setProgress(0);

    let phase: DecryptFailure = 'download';
    try {
      // Fetch the encrypted binary stream
      const response = await fetch(`${backendDomain}/file/${secretKey}`, {
        headers: { Accept: 'application/octet-stream' },
        ...crossOriginCredentials(OIDC_ENABLED),
      });

      if (response.status === 401) {
        setAuthRequired(true);
        return;
      }

      // Gone (consumed, expired or never existed) — retrying can't help
      if (response.status === 404) {
        setNotFound(true);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch file');
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

      phase = 'decrypt';

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
        (decrypted as unknown as { filename?: string }).filename || 'download';
      setFilename(resolvedFilename);

      // Trigger download and keep blob URL for re-download
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setBlobUrl(url);
      downloadUrl(url, resolvedFilename);

      setDone(true);
    } catch {
      setError(phase);
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
    return <DecryptingSpinner progress={progress} />;
  }

  if (authRequired) {
    return <AuthRequiredNotice />;
  }

  if (notFound) {
    return <ErrorPage />;
  }

  if (error === 'download') {
    return (
      <div className="flex flex-col items-center text-center py-16">
        <WarningIcon className="h-14 w-14 text-error mb-4" />
        <h2 className="text-3xl font-bold mb-3">
          {t('display.downloadFailedTitle')}
        </h2>
        <p className="text-base-content/70 mb-8 max-w-sm">
          {t('display.downloadFailedDescription')}
        </p>
        <button
          className="btn btn-primary px-10"
          onClick={() => handleDecrypt(password)}
        >
          {t('display.buttonRetryDownload')}
        </button>
      </div>
    );
  }

  if (error === 'decrypt' || (!done && !password)) {
    return (
      <EnterDecryptionKey
        setPassword={handleDecrypt}
        errorMessage={error === 'decrypt'}
      />
    );
  }

  if (done) {
    return (
      <FileDownloadedCard filename={filename}>
        {blobUrl && (
          <a
            href={blobUrl}
            download={filename}
            className="btn btn-primary btn-sm mt-4"
          >
            {t('secret.buttonDownloadFile')}
          </a>
        )}
      </FileDownloadedCard>
    );
  }

  return null;
}
