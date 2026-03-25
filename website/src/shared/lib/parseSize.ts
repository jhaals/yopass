/**
 * Parse a human-readable size string (e.g. "1MB", "1.5GB", "500K") into bytes.
 * Uses binary units: 1K = 1024, 1M = 1048576, 1G = 1073741824.
 * Returns 0 if the string cannot be parsed.
 */
export function parseSize(s: string): number {
  s = s.trim();
  if (!s) return 0;

  const match = s.match(/^(\d+(?:\.\d+)?)\s*(K|KB|M|MB|G|GB)?$/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const suffix = (match[2] || '').toUpperCase();

  switch (suffix) {
    case 'K':
    case 'KB':
      return Math.round(value * 1024);
    case 'M':
    case 'MB':
      return Math.round(value * 1024 * 1024);
    case 'G':
    case 'GB':
      return Math.round(value * 1024 * 1024 * 1024);
    default:
      return Math.round(value);
  }
}
