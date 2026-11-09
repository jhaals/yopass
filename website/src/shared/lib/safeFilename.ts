// Controls, line separators, invisible fillers and direction overrides have no
// place in a filename. Joiners, tag characters and variation selectors stay inside
// a name: Persian names and emoji sequences need them.
const unsafeCharacters =
  // eslint-disable-next-line no-misleading-character-class -- separate code points, not a sequence
  /[\u034F\p{Cc}\p{Zl}\p{Zp}\u00AD\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/gu;

// An invisible character at the end would change the saved extension.
const invisibleEdges = /^[\s\u200C\u200D]+|[\s\p{Cf}]+$/gu;

// Filenames come from the sender. Direction overrides can disguise the real
// extension (invoice<RLO>fdp.exe shows as invoiceexe.pdf), on screen and on disk.
export function safeFilename(name?: string | null): string {
  const cleaned = (name ?? '')
    .replace(unsafeCharacters, '')
    .replace(invisibleEdges, '');
  // A name of only joiners or selectors would be invisible.
  return /[^\p{C}\p{Z}\uFE00-\uFE0F]/u.test(cleaned) ? cleaned : 'download';
}
