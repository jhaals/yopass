// The request link carries the request ID plus a short public key
// fingerprint in the URL fragment. The fragment is never sent to the server,
// so the responder's browser can detect a public key swapped on the server.
// A request with a label or note also carries the key they are encrypted
// with, which is how the server never gets to read them.
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(-16).toLowerCase();
}

export function requestLink(
  publicUrl: string | undefined,
  id: string,
  fingerprint: string,
  labelKey?: string,
): string {
  const baseURL = publicUrl
    ? publicUrl.replace(/\/$/, '')
    : window.location.origin;
  const link = `${baseURL}/#/r/${id}/${fingerprint}`;
  return labelKey ? `${link}/${encodeURIComponent(labelKey)}` : link;
}
