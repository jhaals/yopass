import { useCallback, useEffect, useRef, useState } from 'react';

// useCopy tracks transient "just copied" state for one or more copy targets.
// Without a key it behaves as a single boolean flag (`isCopied()`); pass a key
// (e.g. a row id) to track which of several targets was copied last. The flag
// resets after resetMs, and the pending timer is cleared on unmount to avoid a
// state update on an unmounted component.
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string, key = 'default') => {
      try {
        await navigator.clipboard.writeText(text);
        if (!mounted.current) return;
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (mounted.current) setCopied(null);
        }, resetMs);
      } catch {
        // Clipboard access can fail (denied permission, insecure context); ignore.
      }
    },
    [resetMs],
  );

  const isCopied = useCallback((key = 'default') => copied === key, [copied]);

  return { copy, isCopied };
}
