import { describe, expect, it } from 'vitest';
import { safeFilename } from './safeFilename';

describe('safeFilename', () => {
  it.each([
    ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['\u2066a\u2069\u200F.txt', 'a.txt'],
    ['line\nbreak.txt', 'linebreak.txt'],
    ['דוח שנתי (final).pdf', 'דוח שנתי (final).pdf'],
    ['a\u2029b.txt', 'ab.txt'],
    ['a\u2028b.txt', 'ab.txt'],
    ['a\u0085b.txt', 'ab.txt'],
    ['a\uFEFFb.txt', 'ab.txt'],
    ['a\u00ADb.txt', 'ab.txt'],
    ['a\u200Bb.txt', 'ab.txt'],
    ['report.pdf', 'report.pdf'],
    ['report.pdf\u200D', 'report.pdf'],
    ['report.pdf\u{E0070}', 'report.pdf'],
    ['invoice.pdf\u3164\u3164.exe', 'invoice.pdf.exe'],
    ['\uFE0F', 'download'],
    ['\u3164', 'download'],
    ['\u200D', 'download'],
    ['\u202E\u200C', 'download'],
    [
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}.png',
      '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}.png',
    ],
    ['\u06DD1.txt', '\u06DD1.txt'],
    ['a\u200Cb\u200Dc.txt', 'a\u200Cb\u200Dc.txt'],
    ['  report.pdf ', 'report.pdf'],
    [' \u00A0', 'download'],
    ['\u202E', 'download'],
    ['', 'download'],
    [undefined, 'download'],
    [null, 'download'],
  ])('%j becomes %j', (name, expected) => {
    expect(safeFilename(name)).toBe(expected);
  });
});
