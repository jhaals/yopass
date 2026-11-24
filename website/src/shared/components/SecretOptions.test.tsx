import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useForm } from 'react-hook-form';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '@shared/lib/config';
import { useSecretForm } from '@shared/hooks/useSecretForm';
import { SecretOptions } from './SecretOptions';

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  isAuthenticated: true,
}));
vi.mock('@shared/hooks/useConfig', () => ({ useConfig: () => state.config }));
vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ loading: false, isAuthenticated: state.isAuthenticated }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

type Fields = {
  expiration: string;
  oneTime: boolean;
  generateKey: boolean;
  customPassword: string;
};

// What the create forms see, so a test can read the values they would submit.
let form: ReturnType<typeof useSecretForm>;

function Form() {
  const current = useSecretForm();
  useEffect(() => {
    form = current;
  });
  const { register, setValue } = useForm<Fields>();
  return (
    <SecretOptions
      expiration="3600"
      register={register}
      setValue={setValue}
      oneTime={current.oneTime}
      setOneTime={current.setOneTime}
      generateKey={current.generateKey}
      setGenerateKey={current.setGenerateKey}
      customPassword={current.customPassword}
      setCustomPassword={current.setCustomPassword}
      requireAuth={false}
      setRequireAuth={() => {}}
      readReceipt={current.readReceipt}
      setReadReceipt={current.setReadReceipt}
      emailNotify={current.emailNotify}
    />
  );
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.config = {
    ...defaultConfig,
    READ_RECEIPTS: true,
    EMAIL_NOTIFICATIONS: true,
    OIDC_ENABLED: true,
  };
  state.isAuthenticated = true;
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function notifyCheckbox() {
  const label = [...host.querySelectorAll('label')].find(l =>
    l.textContent?.includes('create.inputEmailNotifyLabel'),
  );
  return label?.querySelector('input') ?? null;
}

it('offers the email option with its label field and hint once ticked', () => {
  act(() => root.render(<Form />));
  const checkbox = notifyCheckbox();
  expect(checkbox?.checked).toBe(false);
  expect(host.querySelector('#emailLabel')).toBeNull();
  expect(form.emailNotify.enabled).toBe(false);

  act(() => checkbox!.click());
  expect(form.emailNotify.enabled).toBe(true);
  const input = host.querySelector<HTMLInputElement>('#emailLabel')!;
  expect(input.maxLength).toBe(100);
  expect(host.querySelector('#emailLabelHint')?.textContent).toBe(
    'create.inputEmailLabelHint',
  );

  act(() => form.emailNotify.setLabel('Prod DB'));
  expect(input.value).toBe('Prod DB');

  act(() => checkbox!.click());
  expect(host.querySelector('#emailLabel')).toBeNull();
});

it.each([
  ['signed out', () => (state.isAuthenticated = false)],
  ['no mail server', () => (state.config.EMAIL_NOTIFICATIONS = false)],
  ['read receipts off', () => (state.config.READ_RECEIPTS = false)],
])('hides the email option when %s', (_, arrange) => {
  arrange();
  act(() => root.render(<Form />));
  expect(notifyCheckbox()).toBeNull();
  expect(form.emailNotify.available).toBe(false);
  // A stale tick must not survive the option going away.
  act(() => form.emailNotify.setEnabled(true));
  expect(form.emailNotify.enabled).toBe(false);
});
