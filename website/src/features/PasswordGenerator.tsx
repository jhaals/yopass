import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCopy } from '@shared/hooks/useCopy';
import {
  characterSetOrder,
  generatePassword,
  passwordLength,
  passwordStrength,
  type CharacterSet,
  type PasswordStrength,
} from '@shared/lib/password';
import { loadPreferences, savePreferences } from '@shared/lib/preferences';
import {
  CheckLineIcon,
  CopyLineIcon,
  MinusIcon,
  PlusIcon,
  RotateIcon,
} from '@shared/components/icons';

const setLabels: Record<CharacterSet, string> = {
  upper: 'ABC',
  lower: 'abc',
  digits: '123',
  symbols: '#$&',
};

const strengthTones: Record<PasswordStrength, string> = {
  weak: 'bg-error/10 text-error',
  good: 'bg-warning text-warning-content',
  strong: 'bg-secondary text-secondary-content',
  veryStrong: 'bg-secondary text-secondary-content',
};

const stepButtonClass =
  'grid size-9 flex-none cursor-pointer place-items-center rounded-full border border-base-content/20 bg-base-100 text-base-content transition-[background-color,transform] duration-150 hover:bg-base-200 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 pointer-coarse:size-11';

// A random password made in the browser, to copy into a login or into the
// secret above. Length and character sets are remembered like the other
// options; the password itself is never stored.
export default function PasswordGenerator() {
  const { t } = useTranslation();
  const id = useId();
  const [saved] = useState(loadPreferences);
  const [length, setLength] = useState(
    saved.passwordLength ?? passwordLength.default,
  );
  const [sets, setSets] = useState<CharacterSet[]>(
    saved.passwordSets ?? ['upper', 'lower', 'digits'],
  );
  const [password, setPassword] = useState(() =>
    generatePassword(length, sets),
  );
  const { copy, isCopied } = useCopy();
  const strength = passwordStrength(length, sets);

  function update(nextLength: number, nextSets: CharacterSet[]) {
    const clamped = Math.min(
      passwordLength.max,
      Math.max(passwordLength.min, nextLength),
    );
    setLength(clamped);
    setSets(nextSets);
    setPassword(generatePassword(clamped, nextSets));
    savePreferences({ passwordLength: clamped, passwordSets: nextSets });
  }

  function toggle(set: CharacterSet) {
    const on = sets.includes(set);
    update(
      length,
      characterSetOrder.filter(s => (s === set ? !on : sets.includes(s))),
    );
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-4 flex flex-col gap-4 border-t border-base-300 pt-8"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id={`${id}-title`} className="m-0 text-[15px] font-semibold">
            {t('generator.title')}
          </h2>
          <p className="m-0 mt-0.5 text-[12.5px] text-base-content/60">
            {t('generator.hint')}
          </p>
        </div>
        <span
          className={`inline-flex h-[26px] flex-none items-center rounded-full px-2.5 text-[12.5px] font-semibold transition-colors duration-300 ${strengthTones[strength]}`}
        >
          {t(`generator.${strength}`)}
        </span>
      </div>

      <div className="flex overflow-hidden rounded-[10px] border border-base-content/20">
        <output
          aria-live="polite"
          aria-label={t('generator.title')}
          className="block min-w-0 flex-1 truncate bg-base-200/50 px-3.5 font-mono text-sm leading-[46px] select-all"
        >
          {password}
        </output>
        <button
          type="button"
          onClick={() => setPassword(generatePassword(length, sets))}
          aria-label={t('generator.regenerate')}
          title={t('generator.regenerate')}
          className="grid w-12 flex-none cursor-pointer place-items-center border-l border-base-content/20 bg-base-100 text-base-content/75 transition-colors duration-150 hover:bg-base-200 hover:text-base-content active:bg-base-300"
        >
          <RotateIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => copy(password)}
          className="flex h-[46px] min-w-[96px] flex-none cursor-pointer items-center justify-center gap-[7px] border-l border-base-content/20 bg-secondary px-4 text-[13px] font-semibold text-secondary-content transition-colors duration-150 hover:bg-secondary/80"
        >
          {isCopied() ? (
            <CheckLineIcon className="size-3.5" />
          ) : (
            <CopyLineIcon className="size-3.5" />
          )}
          {isCopied() ? t('common.copied') : t('common.copy')}
        </button>
      </div>

      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
        <label htmlFor={`${id}-length`} className="text-[13px] font-semibold">
          {t('generator.length')}:{' '}
          <span className="font-mono tabular-nums">{length}</span>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={t('generator.shorter')}
            disabled={length <= passwordLength.min}
            onClick={() => update(length - 1, sets)}
            className={stepButtonClass}
          >
            <MinusIcon className="size-4" />
          </button>
          <input
            id={`${id}-length`}
            type="range"
            min={passwordLength.min}
            max={passwordLength.max}
            value={length}
            onChange={e => update(Number(e.target.value), sets)}
            className="h-9 min-w-0 flex-1 cursor-pointer accent-(--color-base-content)"
          />
          <button
            type="button"
            aria-label={t('generator.longer')}
            disabled={length >= passwordLength.max}
            onClick={() => update(length + 1, sets)}
            className={stepButtonClass}
          >
            <PlusIcon className="size-4" />
          </button>
        </div>

        <span id={`${id}-sets`} className="text-[13px] font-semibold">
          {t('generator.characters')}
        </span>
        <div
          role="group"
          aria-labelledby={`${id}-sets`}
          className="flex flex-wrap gap-2"
        >
          {characterSetOrder.map(set => {
            const on = sets.includes(set);
            return (
              <label
                key={set}
                className="flex h-9 min-w-14 cursor-pointer items-center justify-center rounded-lg border border-base-content/20 px-3 font-mono text-[13px] font-semibold text-base-content/70 transition-colors duration-150 select-none hover:bg-base-200 has-checked:border-transparent has-checked:bg-neutral has-checked:text-neutral-content has-disabled:cursor-not-allowed has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--lv-focus) pointer-coarse:h-11"
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  // At least one set must stay on.
                  disabled={on && sets.length === 1}
                  onChange={() => toggle(set)}
                  aria-label={t(`generator.${set}`)}
                />
                {setLabels[set]}
              </label>
            );
          })}
        </div>
      </div>
    </section>
  );
}
