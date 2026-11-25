import { shownBlocks } from '@shared/lib/shownText';

// The content of the element that shows a decrypted text. See shownText.ts.
export default function ShownText({ text }: { text: string }) {
  const blocks = shownBlocks(text);
  if (blocks.length < 2) return blocks[0] ?? null;
  // Inline blocks are laid out separately but, unlike blocks, add no line
  // breaks to a selection that is copied by hand.
  return blocks.map((block, index) => (
    <span key={index} className="inline-block w-full align-top">
      {block}
    </span>
  ));
}
