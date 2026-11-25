import { describe, expect, it } from 'vitest';
import { isTruncated, maxShownCharacters, shownBlocks } from './shownText';

describe('shownBlocks', () => {
  it.each([
    ['', []],
    ['hunter2', ['hunter2']],
    ['a\nb\n', ['a\nb\n']],
  ])('keeps %j in one piece', (text, blocks) => {
    expect(shownBlocks(text)).toEqual(blocks);
    expect(isTruncated(text)).toBe(false);
  });

  it.each([
    ['one long line', 'x'.repeat(maxShownCharacters)],
    ['short lines', 'line\n'.repeat(maxShownCharacters / 5)],
    ['empty lines', '\n'.repeat(maxShownCharacters)],
    ['surrogate pairs', 'a' + '\u{1F511}'.repeat(maxShownCharacters / 2 - 1)],
    ['direction changes', 'aא'.repeat(maxShownCharacters / 2)],
  ])('divides %s into bounded pieces that join to the text', (_, text) => {
    const blocks = shownBlocks(text);
    expect(blocks.join('')).toBe(text);
    expect(Math.max(...blocks.map(block => block.length))).toBeLessThan(1002);
    expect(isTruncated(text)).toBe(false);
  });

  it('divides after line breaks', () => {
    const blocks = shownBlocks('line\n'.repeat(1000));
    expect(blocks.every(block => block.endsWith('\n'))).toBe(true);
  });

  it('divides a long line after spaces', () => {
    const text = 'word '.repeat(1000);
    const blocks = shownBlocks(text);
    expect(blocks.join('')).toBe(text);
    expect(blocks.every(block => block.endsWith('word '))).toBe(true);
  });

  it('does not divide a surrogate pair', () => {
    const blocks = shownBlocks('a' + '\u{1F511}'.repeat(maxShownCharacters));
    expect(blocks.every(block => /^a?(\u{1F511})+$/u.test(block))).toBe(true);
    expect(blocks.join('').length).toBe(maxShownCharacters - 1);
  });

  it('shows only the beginning of a longer text', () => {
    const text = 'aא'.repeat(1 << 19);
    expect(isTruncated(text)).toBe(true);
    expect(shownBlocks(text).join('')).toBe(text.slice(0, maxShownCharacters));
  });
});
