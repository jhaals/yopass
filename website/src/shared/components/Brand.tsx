// The urlx fingerprint: four ridge arcs plus scattered pores, drawn on a
// 48×48 grid. FingerprintMark is the logo tile (ink square, lime ridges);
// FingerprintRidges is the bare ridge drawing used as a watermark.

const ridges = [
  'M7.56 30.99A17.5 17.5 0 0 1 18.01 8.56',
  'M13.35 32.46A13 13 0 0 1 33.96 16.64',
  'M19.12 31.96A8.5 8.5 0 1 1 31.36 20.75',
  'M22.63 28.76A4 4 0 1 1 28 25',
];

const pores: [number, number, number][] = [
  [25.53, 7.57, 1.2],
  [32.22, 9.55, 0.9],
  [36.56, 21.64, 1.25],
  [36.87, 26.81, 1],
  [35.26, 31.5, 0.75],
  [32.47, 24.26, 1.2],
  [31.88, 28.18, 0.9],
];

function Ridges({ color }: { color: string }) {
  return (
    <>
      <g stroke={color} strokeWidth="2.4" strokeLinecap="round">
        {ridges.map(d => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill={color}>
        {pores.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>
    </>
  );
}

export function FingerprintMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="4" y="4" width="40" height="40" rx="11" fill="#0b0d12" />
      <Ridges color="#c6f135" />
    </svg>
  );
}

export function FingerprintRidges({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <Ridges color="currentColor" />
    </svg>
  );
}
