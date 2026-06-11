// Guards against translation drift: every locale file under
// src/shared/locales must contain exactly the same set of keys as en.json
// (the source of truth). A missing key silently falls back at runtime, so we
// turn that class of mistake into a build failure instead.
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

const expected = new Set(keyPaths(load(reference)));
const files = readdirSync(localesDir).filter(
  f => f.endsWith('.json') && f !== reference,
);

let failed = false;
for (const file of files) {
  const actual = new Set(keyPaths(load(file)));
  const missing = [...expected].filter(k => !actual.has(k));
  const extra = [...actual].filter(k => !expected.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`\n${file} is out of sync with ${reference}:`);
    for (const k of missing) console.error(`  missing: ${k}`);
    for (const k of extra) console.error(`  extra:   ${k}`);
  }
}

if (failed) {
  console.error(
    `\nLocale key check failed. Align each locale with ${reference}.`,
  );
  process.exit(1);
}

console.log(
  `Locale key check passed (${files.length} locales match ${reference}).`,
);
