// Shakes an element sideways to flag bad input. Skipped when the user
// prefers reduced motion; the error message carries the meaning on its own.
export function shake(el: HTMLElement | null) {
  if (!el?.animate) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  el.animate(
    [0, -7, 7, -5, 4, -2, 0].map(x => ({ transform: `translateX(${x}px)` })),
    { duration: 420, easing: 'ease-out' },
  );
}
