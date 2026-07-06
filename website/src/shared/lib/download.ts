// Triggers a browser download of binary data by creating a temporary object
// URL and clicking a hidden anchor. The URL is revoked immediately; callers
// that need a persistent URL for re-download should manage it themselves.
export function downloadBlob(data: BlobPart, filename: string) {
  const blob =
    data instanceof Blob
      ? data
      : new Blob([data], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  URL.revokeObjectURL(url);
}

// Downloads an already-created object URL without revoking it.
export function downloadUrl(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
