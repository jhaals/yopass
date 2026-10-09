import { useState } from 'react';
import { randomString } from '@shared/lib/random';
import { useConfig } from '@shared/hooks/useConfig';

export interface SecretFormState {
  readReceipt: boolean;
  setReadReceipt: (value: boolean) => void;
  oneTime: boolean;
  setOneTime: (value: boolean) => void;
  generateKey: boolean;
  setGenerateKey: (value: boolean) => void;
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

export function useSecretForm(): SecretFormState {
  const config = useConfig();
  const [oneTime, setOneTime] = useState(
    config.FORCE_ONETIME_SECRETS || config.DEFAULT_ONETIME_SECRETS,
  );
  const [readReceipt, setReadReceipt] = useState(
    config.READ_RECEIPTS && config.DEFAULT_READ_RECEIPT,
  );
  const [generateKey, setGenerateKey] = useState(true);
  const [customPassword, setCustomPassword] = useState('');
  const [result, setResult] = useState({
    password: '',
    uuid: '',
    customPassword: false,
  });

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
    customPassword,
    setCustomPassword,
    result,
    setResult,
    getPassword,
    isCustomPassword,
  };
}
