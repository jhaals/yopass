// Guards against translation drift: every locale file under
// src/shared/locales must contain exactly the same set of keys as en.json
// (the source of truth). A missing key silently falls back at runtime, so we
// turn that class of mistake into a build failure instead. Plural keys are the
// exception: each locale must have exactly the forms its language uses.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/shared/locales',
);
const reference = 'en.json';

// Flattens a nested translation object into the set of dotted key paths,
// e.g. { a: { b: 1 } } -> ["a.b"].
function keyPaths(obj, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...keyPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function load(file) {
  return JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
}

// Forms current CLDR dropped but browsers with older data still request.
const legacyPluralForms = { he: ['many'] };

// Expands plural keys to the forms the language needs, e.g. a_one + a_other in
// en.json becomes a_one + a_few + a_many + a_other for ru.
// shortcut: treats any key with these suffixes as plural, rename such a key if
// it is not one. _zero is optional in i18next, so it counts as an ordinary key.
function expectedKeys(language, keys) {
  const { pluralCategories } = new Intl.PluralRules(language).resolvedOptions();
  return new Set(
    keys.flatMap(key => {
      const base = key.replace(/_(one|two|few|many|other)$/, '');
      if (base === key) return [key];
      return [...pluralCategories, ...(legacyPluralForms[language] ?? [])].map(
        c => `${base}_${c}`,
      );
    }),
  );
}

const referenceKeys = keyPaths(load(reference));
// en.json is included so its own plural keys are complete too.
const files = readdirSync(localesDir).filter(f => f.endsWith('.json'));

let failed = false;
for (const file of files) {
  const expected = expectedKeys(file.replace('.json', ''), referenceKeys);
  const actual = new Set(keyPaths(load(file)));
  const missing = [...expected].filter(k => !actual.has(k));
  const extra = [...actual].filter(k => !expected.has(k));
  if (missing.length) {
    failed = true;
    console.error(
      `\n${file} has missing keys (i18next will fall back to ${reference}):`,
    );
    for (const k of missing) console.error(`  missing: ${k}`);
  }
  if (extra.length) {
    failed = true;
    console.error(`\n${file} has keys not in ${reference}:`);
    for (const k of extra) console.error(`  extra:   ${k}`);
  }
}

if (failed) {
  console.error(
    `\nLocale key check failed. Add missing keys and remove extra keys to match ${reference} (plural keys follow each language's forms).`,
  );
  process.exit(1);
}

console.log(
  `Locale key check passed (${files.length - 1} locales checked against ${reference}).`,
);
