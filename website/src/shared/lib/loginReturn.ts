// The OIDC callback always lands on the home page, and the route (including a
// secret's decryption key) lives in the URL fragment, which never reaches the
// server. Keep it in this tab's sessionStorage across the login round trip.
const STORAGE_KEY = 'yopass-login-return';

export function rememberLoginReturn() {
  try {
    if (
      window.location.hash.startsWith('#/') &&
      window.location.hash !== '#/'
    ) {
      sessionStorage.setItem(STORAGE_KEY, window.location.hash);
    } else {
      // Drop a route left behind by an earlier, failed login in this tab.
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable: the user lands on the home page as before.
  }
}

// Called once at startup, before the router reads the hash.
export function restoreLoginReturn() {
  try {
    const hash = sessionStorage.getItem(STORAGE_KEY);
    if (!hash) return;
    sessionStorage.removeItem(STORAGE_KEY);
    const onHome = window.location.hash === '' || window.location.hash === '#/';
    // A login_error keeps the user on the home page where the notice is shown.
    const loginError = new URLSearchParams(window.location.search).has(
      'login_error',
    );
    if (onHome && !loginError && hash.startsWith('#/')) {
      window.history.replaceState(null, '', window.location.pathname + hash);
    }
  } catch {
    // Storage unavailable: stay on the home page.
  }
}
