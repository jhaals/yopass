import { useState } from 'react';
import { randomString } from '@shared/lib/random';
import { loadPreferences, savePreferences } from '@shared/lib/preferences';
import { useConfig } from '@shared/hooks/useConfig';

export interface SecretFormState {
  readReceipt: boolean;
  setReadReceipt: (value: boolean) => void;
  oneTime: boolean;
  setOneTime: (value: boolean) => void;
  generateKey: boolean;
  setGenerateKey: (value: boolean) => void;
  requireAuth: boolean;
  setRequireAuth: (value: boolean) => void;
  customPassword: string;
  setCustomPassword: (value: string) => void;
  result: {
    password: string;
    uuid: string;
    customPassword: boolean;
  };
  setResult: (result: {
    password: string;
    uuid: string;
    customPassword: boolean;
  }) => void;
  getPassword: () => string;
  isCustomPassword: () => boolean;
}

// Form state shared by the text and file compose screens. Option toggles
// start from the sender's remembered choices (see shared/lib/preferences),
// falling back to the server defaults, and are remembered when changed.
export function useSecretForm(): SecretFormState {
  const config = useConfig();
  const [saved] = useState(loadPreferences);
  const [oneTime, setOneTimeState] = useState(
    config.FORCE_ONETIME_SECRETS ||
      (saved.oneTime ?? config.DEFAULT_ONETIME_SECRETS),
  );
  const [readReceipt, setReadReceiptState] = useState(
    config.READ_RECEIPTS && (saved.readReceipt ?? config.DEFAULT_READ_RECEIPT),
  );
  const [generateKey, setGenerateKeyState] = useState(
    saved.generateKey ?? true,
  );
  const [requireAuth, setRequireAuthState] = useState(
    config.OIDC_ENABLED && (saved.requireAuth ?? false),
  );
  const [customPassword, setCustomPassword] = useState('');
  const [result, setResult] = useState({
    password: '',
    uuid: '',
    customPassword: false,
  });

  function setOneTime(value: boolean) {
    setOneTimeState(value);
    savePreferences({ oneTime: value });
  }

  function setReadReceipt(value: boolean) {
    setReadReceiptState(value);
    savePreferences({ readReceipt: value });
  }

  function setGenerateKey(value: boolean) {
    setGenerateKeyState(value);
    savePreferences({ generateKey: value });
  }

  function setRequireAuth(value: boolean) {
    setRequireAuthState(value);
    savePreferences({ requireAuth: value });
  }

  function getPassword() {
    return !generateKey && customPassword ? customPassword : randomString();
  }

  function isCustomPassword() {
    return !!customPassword && !generateKey;
  }

  return {
    readReceipt,
    setReadReceipt,
    oneTime,
    setOneTime,
    generateKey,
    setGenerateKey,
    requireAuth,
    setRequireAuth,
    customPassword,
    setCustomPassword,
    result,
    setResult,
    getPassword,
    isCustomPassword,
  };
}
