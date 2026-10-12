import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '@shared/lib/clipboard';

// useCopy tracks transient "just copied" state for one or more copy targets.
// Without a key it behaves as a single boolean flag (`isCopied()`); pass a key
// (e.g. a row id) to track which of several targets was copied last. The flag
// is only set when the text actually reached the clipboard, resets after
// resetMs, and the pending timer is cleared on unmount.
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string, key = 'default') => {
      const copiedText = await copyText(text);
      if (copiedText) {
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), resetMs);
      }
      return copiedText;
    },
    [resetMs],
  );

  const isCopied = useCallback((key = 'default') => copied === key, [copied]);

  return { copy, isCopied };
}
