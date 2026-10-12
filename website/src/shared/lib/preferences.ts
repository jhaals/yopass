import type { Config } from './config';
import { initialExpiration, validExpiration } from './expiration';
import { isCharacterSet, passwordLength, type CharacterSet } from './password';

// The sender's last chosen secret and password-generator options, remembered
// in this browser and restored as the starting values next time. Server
// policy (forced one-time, forced expiration, disabled features) always wins
// over them.
// The custom password is never stored.
const STORAGE_KEY = 'urlx-secret-options';

export interface SecretPreferences {
  expiration?: string;
  oneTime?: boolean;
  generateKey?: boolean;
  requireAuth?: boolean;
  readReceipt?: boolean;
  passwordLength?: number;
  passwordSets?: CharacterSet[];
}

export function loadPreferences(): SecretPreferences {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const stored = raw as Record<string, unknown>;
    const prefs: SecretPreferences = {};
    if (
      typeof stored.expiration === 'string' &&
      /^\d+$/.test(stored.expiration)
    )
      prefs.expiration = stored.expiration;
    for (const key of [
      'oneTime',
      'generateKey',
      'requireAuth',
      'readReceipt',
    ] as const) {
      if (typeof stored[key] === 'boolean') prefs[key] = stored[key];
    }
    const length = stored.passwordLength;
    if (
      typeof length === 'number' &&
      Number.isInteger(length) &&
      length >= passwordLength.min &&
      length <= passwordLength.max
    )
      prefs.passwordLength = length;
    const sets = stored.passwordSets;
    if (Array.isArray(sets) && sets.length > 0 && sets.every(isCharacterSet))
      prefs.passwordSets = sets;
    return prefs;
  } catch {
    return {};
  }
}

export function savePreferences(patch: SecretPreferences) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...loadPreferences(), ...patch }),
    );
  } catch {
    // Storage unavailable (private mode, quota); preferences are best effort.
  }
}

// Saves a chosen lifetime. Custom deadlines ("at:<timestamp>") are absolute
// and would be stale next time, so only relative lifetimes are remembered.
export function saveExpiration(value: string) {
  if (/^\d+$/.test(value)) savePreferences({ expiration: value });
}

// The remembered lifetime when the server still accepts it, else the
// server's default.
export function preferredExpiration(config: Config): string {
  const saved = loadPreferences().expiration;
  return saved && validExpiration(saved, config)
    ? saved
    : initialExpiration(config);
}
