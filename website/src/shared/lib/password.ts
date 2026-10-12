import { randomInt } from './random';

export const characterSets = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!#$%&*+-=?@^_~',
} as const;

export type CharacterSet = keyof typeof characterSets;

export const characterSetOrder: CharacterSet[] = [
  'upper',
  'lower',
  'digits',
  'symbols',
];

export const passwordLength = { min: 8, max: 64, default: 16 };

export function isCharacterSet(value: unknown): value is CharacterSet {
  return typeof value === 'string' && value in characterSets;
}

// Builds a password from the chosen sets with the browser's CSPRNG (randomInt
// rejects biased bytes). Every chosen set appears at least once, then all
// positions are shuffled so those guaranteed characters aren't predictable.
export function generatePassword(length: number, sets: CharacterSet[]): string {
  const chosen = sets.map(set => characterSets[set]);
  const pool = chosen.join('');
  const chars = chosen.map(set => set[randomInt(0, set.length)]);
  while (chars.length < length) chars.push(pool[randomInt(0, pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export type PasswordStrength = 'weak' | 'good' | 'strong' | 'veryStrong';

// Rates the entropy of a random password of this length and pool, in bits.
export function passwordStrength(
  length: number,
  sets: CharacterSet[],
): PasswordStrength {
  const pool = sets.reduce((size, set) => size + characterSets[set].length, 0);
  const bits = length * Math.log2(pool);
  if (bits < 50) return 'weak';
  if (bits < 70) return 'good';
  if (bits < 90) return 'strong';
  return 'veryStrong';
}
