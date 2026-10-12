// Copies text and reports whether it reached the clipboard. The async
// Clipboard API only exists in secure contexts (HTTPS or localhost), so
// plain-HTTP deployments fall back to the legacy copy command.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable; try the legacy path below.
  }
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}
