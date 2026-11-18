import { beforeEach, describe, expect, it } from 'vitest';
import { rememberLoginReturn, restoreLoginReturn } from './loginReturn';

describe('loginReturn', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('restores the secret route after the login round trip', () => {
    window.history.replaceState(null, '', '/#/s/abc/key');
    rememberLoginReturn();
    window.history.replaceState(null, '', '/');
    restoreLoginReturn();
    expect(window.location.hash).toBe('#/s/abc/key');
    expect(sessionStorage.length).toBe(0);
  });

  it('stays on home when login failed', () => {
    window.history.replaceState(null, '', '/#/s/abc/key');
    rememberLoginReturn();
    window.history.replaceState(null, '', '/?login_error=license_expired');
    restoreLoginReturn();
    expect(window.location.hash).toBe('');
    expect(sessionStorage.length).toBe(0);
  });

  it('does not override a route the user navigated to', () => {
    window.history.replaceState(null, '', '/#/s/abc/key');
    rememberLoginReturn();
    window.history.replaceState(null, '', '/#/upload');
    restoreLoginReturn();
    expect(window.location.hash).toBe('#/upload');
    expect(sessionStorage.length).toBe(0);
  });

  it('clears a stale route when logging in from home', () => {
    window.history.replaceState(null, '', '/#/s/abc/key');
    rememberLoginReturn();
    window.history.replaceState(null, '', '/#/');
    rememberLoginReturn();
    expect(sessionStorage.length).toBe(0);
  });
});
