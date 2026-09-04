// Helpers for the recipient list a creator binds a secret to.
//
// The list is typed as free text and split here rather than in a chip editor:
// the server is the authority on what it accepts, so the client only needs to
// split, trim and drop blanks, plus a cheap shape check for inline feedback.

// Matches the server's validRecipient closely enough for form feedback. The
// server, not this, decides what is finally accepted.
const EMAIL_SHAPE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

// Maximum addresses per secret; mirrors maxRecipients in pkg/server.
export const MAX_RECIPIENTS = 10;

// parseRecipients splits a comma- or whitespace-separated list into trimmed,
// non-empty addresses, preserving order and dropping duplicates.
export function parseRecipients(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(/[\s,;]+/)) {
    const addr = part.trim();
    if (addr === '') continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

// recipientListError returns a translation key for the first problem with the
// list, or null when it is acceptable.
export function recipientListError(input: string): string | null {
  const recipients = parseRecipients(input);
  if (recipients.length === 0) {
    return null;
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return 'verification.tooManyRecipients';
  }
  if (recipients.some(addr => !EMAIL_SHAPE.test(addr))) {
    return 'verification.invalidRecipient';
  }
  return null;
}
