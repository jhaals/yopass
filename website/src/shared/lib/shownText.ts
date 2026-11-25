// Decrypted text comes from the other party, and --max-length does not bound
// it: a compressed message expands, and a request answer that does not decrypt
// is shown as received. Browsers need quadratic time or worse to lay out one
// block of some text, e.g. when the writing direction changes after every
// character, which hangs the tab for minutes.
//
// So only the first maxShownCharacters are rendered (copying still takes all of
// the text), in pieces that are each laid out on their own. The limit is the
// default --max-length, which no uncompressed secret exceeds on a default server.
export const maxShownCharacters = 10000;
const maxBlockCharacters = 1000;

export function isTruncated(text: string): boolean {
  return text.length > maxShownCharacters;
}

function dividesSurrogatePair(text: string, index: number): boolean {
  return /[\uDC00-\uDFFF]/.test(text.charAt(index));
}

// The pieces join to the shown text. A piece ends after a line break where
// there is one and else after a space, so only a longer line wraps early and
// only a longer word is divided.
export function shownBlocks(text: string): string[] {
  const shown = text.slice(
    0,
    maxShownCharacters - Number(dividesSurrogatePair(text, maxShownCharacters)),
  );
  const blocks: string[] = [];
  let start = 0;
  while (start < shown.length) {
    let end = Math.min(start + maxBlockCharacters, shown.length);
    if (end < shown.length) {
      const lineBreak = shown.lastIndexOf('\n', end - 1);
      const space = shown.lastIndexOf(' ', end - 1);
      if (lineBreak >= start) end = lineBreak + 1;
      else if (space >= start) end = space + 1;
      else if (dividesSurrogatePair(shown, end)) end += 1;
    }
    blocks.push(shown.slice(start, end));
    start = end;
  }
  return blocks;
}
