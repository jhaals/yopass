import { useState } from 'react';
import { randomString } from '@shared/lib/random';
import { useConfig } from '@shared/hooks/useConfig';
import { useAuth } from '@shared/hooks/useAuth';

export interface SecretFormState {
  readReceipt: boolean;
  setReadReceipt: (value: boolean) => void;
  // Whether the "email me" option is offered: the mail goes to the signed-in
  // user and rides on a read receipt.
  canEmailNotify: boolean;
  emailNotify: boolean;
  setEmailNotify: (value: boolean) => void;
  emailLabel: string;
  setEmailLabel: (value: string) => void;
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
  const { isAuthenticated } = useAuth();
  const canEmailNotify =
    config.EMAIL_NOTIFICATIONS && config.READ_RECEIPTS && isAuthenticated;
  const [emailNotify, setEmailNotify] = useState(false);
  const [emailLabel, setEmailLabel] = useState('');
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
    canEmailNotify,
    emailNotify: canEmailNotify && emailNotify,
    setEmailNotify,
    emailLabel,
    setEmailLabel,
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
