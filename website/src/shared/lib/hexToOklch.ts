export function hexToOklch(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const r = parseInt(match[1].substring(0, 2), 16) / 255;
  const g = parseInt(match[1].substring(2, 4), 16) / 255;
  const b = parseInt(match[1].substring(4, 6), 16) / 255;
  // sRGB to linear
  function toLinear(c: number) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const lr = toLinear(r),
    lg = toLinear(g),
    lb = toLinear(b);
  // Linear RGB to OKLab
  const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l = Math.cbrt(l_),
    m = Math.cbrt(m_),
    s = Math.cbrt(s_);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(a * a + bOk * bOk);
  const h = (Math.atan2(bOk, a) * 180) / Math.PI;
  return `${(L * 100).toFixed(2)}% ${C.toFixed(4)} ${((h + 360) % 360).toFixed(2)}`;
}
