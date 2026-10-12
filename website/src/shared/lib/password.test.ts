import { expect, it } from 'vitest';
import {
  characterSets,
  generatePassword,
  passwordStrength,
  type CharacterSet,
} from './password';

it('uses only the chosen sets and includes each of them', () => {
  const sets: CharacterSet[] = ['lower', 'digits', 'symbols'];
  const allowed = new Set(sets.flatMap(set => [...characterSets[set]]));
  for (let run = 0; run < 200; run++) {
    const password = generatePassword(8, sets);
    expect(password).toHaveLength(8);
    expect([...password].every(char => allowed.has(char))).toBe(true);
    for (const set of sets) {
      expect(
        [...password].some(char => characterSets[set].includes(char)),
      ).toBe(true);
    }
  }
});

it('produces different passwords', () => {
  const seen = new Set(
    Array.from({ length: 50 }, () =>
      generatePassword(16, ['upper', 'lower', 'digits']),
    ),
  );
  expect(seen.size).toBe(50);
});

it('rates strength by entropy', () => {
  expect(passwordStrength(8, ['lower'])).toBe('weak');
  expect(passwordStrength(10, ['upper', 'lower', 'digits', 'symbols'])).toBe(
    'good',
  );
  expect(passwordStrength(12, ['upper', 'lower', 'digits'])).toBe('strong');
  expect(passwordStrength(16, ['upper', 'lower', 'digits'])).toBe('veryStrong');
});
