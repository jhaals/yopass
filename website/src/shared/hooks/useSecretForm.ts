import { useState } from 'react';
import { randomString } from '@shared/lib/random';

export interface SecretFormState {
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
  const [oneTime, setOneTime] = useState(true);
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
