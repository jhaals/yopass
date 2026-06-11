// The request link carries the request ID plus a short public key
// fingerprint in the URL fragment. The fragment is never sent to the server,
// so the responder's browser can detect a public key swapped on the server.
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(-16).toLowerCase();
}

export function requestLink(
  publicUrl: string | undefined,
  id: string,
  fingerprint: string,
): string {
  const baseURL = publicUrl
    ? publicUrl.replace(/\/$/, '')
    : window.location.origin;
  return `${baseURL}/#/r/${id}/${fingerprint}`;
}
