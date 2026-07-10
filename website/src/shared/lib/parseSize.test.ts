import { describe, expect, it } from 'vitest';

import { parseSize } from './parseSize';

describe('parseSize', () => {
  it('parses plain byte values', () => {
    expect(parseSize('0')).toBe(0);
    expect(parseSize('42')).toBe(42);
    expect(parseSize('1048576')).toBe(1048576);
  });

  it('parses binary unit suffixes', () => {
    expect(parseSize('1K')).toBe(1024);
    expect(parseSize('1KB')).toBe(1024);
    expect(parseSize('1M')).toBe(1024 * 1024);
    expect(parseSize('1MB')).toBe(1024 * 1024);
    expect(parseSize('1G')).toBe(1024 * 1024 * 1024);
    expect(parseSize('1GB')).toBe(1024 * 1024 * 1024);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseSize('1kb')).toBe(1024);
    expect(parseSize('1 MB')).toBe(1024 * 1024);
    expect(parseSize('  5K  ')).toBe(5120);
  });

  it('parses decimal values and rounds to whole bytes', () => {
    expect(parseSize('1.5K')).toBe(1536);
    expect(parseSize('1.5GB')).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
    expect(parseSize('0.1K')).toBe(102);
  });

  it('returns 0 for invalid input', () => {
    expect(parseSize('')).toBe(0);
    expect(parseSize('   ')).toBe(0);
    expect(parseSize('abc')).toBe(0);
    expect(parseSize('1TB')).toBe(0);
    expect(parseSize('-1K')).toBe(0);
    expect(parseSize('1.2.3K')).toBe(0);
    expect(parseSize('K')).toBe(0);
    expect(parseSize('1K extra')).toBe(0);
  });
});
