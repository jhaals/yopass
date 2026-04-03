import { readMessage, decrypt } from 'openpgp';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import JSZip from 'jszip';
import {
  backendDomain,
  getBundle,
  type BundleFile,
} from '@shared/lib/api';
import EnterDecryptionKey from './EnterDecryptionKey';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function fetchAndDecryptFile(
  fileKey: string,
  password: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`${backendDomain}/file/${fileKey}`, {
    headers: { Accept: 'application/octet-stream' },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch file');
  }

  const serverFilename = response.headers.get('X-Yopass-Filename');

  if (!response.body) {
    throw new Error('No response body');
  }

  const message = await readMessage({
    binaryMessage: response.body as ReadableStream<Uint8Array>,
  });
  const decrypted = await decrypt({
    message,
    passwords: password,
    format: 'binary',
  });

  const blob = await new Response(
    decrypted.data as ReadableStream<Uint8Array>,
  ).blob();

  const resolvedFilename =
    (decrypted as unknown as { filename?: string }).filename ||
    serverFilename ||
    'download';

  return { blob, filename: resolvedFilename };
}

export default function BundleDownload({ bundleKey }: { bundleKey: string }) {
  const { t } = useTranslation();
  const { password: paramsPassword } = useParams();
  const [password, setPassword] = useState(() => paramsPassword ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [bundleFiles, setBundleFiles] = useState<BundleFile[]>([]);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [zipProgress, setZipProgress] = useState<number | null>(null);

  // Fetch bundle manifest
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    (async () => {
      try {
        const manifest = await getBundle(bundleKey);
        setBundleFiles(manifest.files);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [bundleKey]);

  async function handleDownloadSingle(file: BundleFile) {
    if (!password) return;
    setDownloadingFile(file.key);
    try {
      const { blob, filename } = await fetchAndDecryptFile(file.key, password);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch {
      setError(true);
    } finally {
      setDownloadingFile(null);
    }
  }

  async function handleDownloadAllZip() {
    if (!password || bundleFiles.length === 0) return;
    setDownloadingAll(true);
    setZipProgress(0);

    try {
      const zip = new JSZip();

      for (let i = 0; i < bundleFiles.length; i++) {
        const file = bundleFiles[i];
        const { blob, filename } = await fetchAndDecryptFile(
          file.key,
          password,
        );
        zip.file(filename, blob);
        setZipProgress(Math.round(((i + 1) / bundleFiles.length) * 90));
      }

      setZipProgress(95);
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setZipProgress(100);

      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'yopass-bundle.zip';
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch {
      setError(true);
    } finally {
      setDownloadingAll(false);
      setZipProgress(null);
    }
  }

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
        <p className="mt-4 text-lg font-medium">{t('display.loading')}</p>
      </div>
    );
  }

  if (error && bundleFiles.length === 0) {
    return (
      <div className="alert alert-error">
        <span>
          {t('bundle.errorLoadFailed', {
            defaultValue: 'Failed to load bundle. It may have expired or been deleted.',
          })}
        </span>
      </div>
    );
  }

  // Need password
  if (!password) {
    return (
      <EnterDecryptionKey setPassword={setPassword} errorMessage={error} />
    );
  }

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
            d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"
          />
        </svg>
        <h2 className="text-3xl font-bold">
          {t('bundle.title', { defaultValue: 'File Bundle' })}
        </h2>
      </div>
      <p className="mb-6 text-base-content/70">
        {t('bundle.subtitle', {
          count: bundleFiles.length,
          defaultValue: 'This bundle contains {{count}} encrypted file(s).',
        })}
      </p>

      {error && (
        <div
          className="alert alert-error mb-4 cursor-pointer"
          onClick={() => setError(false)}
        >
          <span>
            {t('bundle.errorDecryptFailed', {
              defaultValue: 'Failed to decrypt file. The password may be incorrect.',
            })}
          </span>
        </div>
      )}

      {/* Download All as Zip */}
      {bundleFiles.length > 1 && (
        <div className="mb-6">
          <button
            className="btn btn-primary w-full h-12 text-base font-semibold rounded-lg"
            onClick={handleDownloadAllZip}
            disabled={downloadingAll || downloadingFile !== null}
          >
            {downloadingAll ? (
              <>
                <svg
                  className="animate-spin h-5 w-5 mr-2"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
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
                {t('bundle.downloadingZip', {
                  defaultValue: 'Creating zip...',
                })}
              </>
            ) : (
              <>
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
                {t('bundle.downloadAllZip', {
                  defaultValue: 'Download All as Zip',
                })}
              </>
            )}
          </button>
          {zipProgress !== null && (
            <div className="mt-2">
              <progress
                className="progress progress-primary w-full"
                value={zipProgress}
                max="100"
              />
              <p className="text-sm text-center mt-1">{zipProgress}%</p>
            </div>
          )}
        </div>
      )}

      {/* File list */}
      <div className="space-y-3">
        {bundleFiles.map((file) => (
          <div
            key={file.key}
            className="flex items-center justify-between bg-base-200 border border-base-300 rounded-xl px-5 py-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-6 h-6 shrink-0 text-base-content/60"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                />
              </svg>
              <div className="min-w-0">
                <div className="font-medium truncate">{file.filename}</div>
                <div className="text-xs text-base-content/50">
                  {formatFileSize(file.size)}
                </div>
              </div>
            </div>
            <button
              className="btn btn-primary btn-sm shrink-0 ml-4"
              onClick={() => handleDownloadSingle(file)}
              disabled={
                downloadingFile !== null || downloadingAll
              }
            >
              {downloadingFile === file.key ? (
                <svg
                  className="animate-spin h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
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
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-4 h-4"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25"
                  />
                </svg>
              )}
              {t('bundle.download', { defaultValue: 'Download' })}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
