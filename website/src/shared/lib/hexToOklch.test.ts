import { describe, it, expect } from 'vitest';
import { hexToOklch } from './hexToOklch';

function parseOklch(result: string) {
  const [L, C, h] = result.split(' ').map(parseFloat);
  return { L, C, h };
}

describe('hexToOklch', () => {
  it('returns null for invalid hex', () => {
    expect(hexToOklch('')).toBeNull();
    expect(hexToOklch('not-a-color')).toBeNull();
    expect(hexToOklch('#fff')).toBeNull(); // 3-char hex not supported
    expect(hexToOklch('#gggggg')).toBeNull();
  });

  it('converts black (#000000)', () => {
    const result = hexToOklch('#000000')!;
    const { L, C } = parseOklch(result);
    expect(L).toBeCloseTo(0, 1);
    expect(C).toBeCloseTo(0, 3);
  });

  it('converts white (#ffffff)', () => {
    const result = hexToOklch('#ffffff')!;
    const { L, C } = parseOklch(result);
    expect(L).toBeCloseTo(100, 0);
    expect(C).toBeCloseTo(0, 2);
  });

  it('converts pure red (#ff0000)', () => {
    const result = hexToOklch('#ff0000')!;
    const { L, C, h } = parseOklch(result);
    // Reference: oklch(62.80% 0.2577 29.23)
    expect(L).toBeCloseTo(62.8, 0);
    expect(C).toBeCloseTo(0.2577, 2);
    expect(h).toBeCloseTo(29.23, 0);
  });

  it('converts pure green (#00ff00)', () => {
    const result = hexToOklch('#00ff00')!;
    const { L, C, h } = parseOklch(result);
    // Reference: oklch(86.64% 0.2948 142.50)
    expect(L).toBeCloseTo(86.64, 0);
    expect(C).toBeCloseTo(0.2948, 2);
    expect(h).toBeCloseTo(142.5, 0);
  });

  it('converts pure blue (#0000ff)', () => {
    const result = hexToOklch('#0000ff')!;
    const { L, C, h } = parseOklch(result);
    // Reference: oklch(45.20% 0.3132 264.05)
    expect(L).toBeCloseTo(45.2, 0);
    expect(C).toBeCloseTo(0.3132, 2);
    expect(h).toBeCloseTo(264.05, 0);
  });

  it('converts an amber/yellow tone (#f0a500)', () => {
    const result = hexToOklch('#f0a500')!;
    const { L, C, h } = parseOklch(result);
    expect(L).toBeCloseTo(77.5, 0);
    expect(C).toBeCloseTo(0.163, 2);
    expect(h).toBeCloseTo(76.2, 0);
  });

  it('works without # prefix', () => {
    expect(hexToOklch('ff0000')).toBe(hexToOklch('#ff0000'));
  });

  it('is case insensitive', () => {
    expect(hexToOklch('#FF0000')).toBe(hexToOklch('#ff0000'));
  });
});
