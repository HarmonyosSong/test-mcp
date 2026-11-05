import { loginUrl } from './session-fetch';

const LOGIN_ATTEMPT_KEY = 'xesapp-agent-sso-login-attempted';

interface LoginBrowser {
  location: Pick<Location, 'pathname' | 'search' | 'replace'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

export type LoginNavigationState = 'redirecting' | 'login' | 'logged-out';

/** Tab-local marker only; never establishes identity. */
export function createLoginNavigation(browser: LoginBrowser) {
  let navigating = false;
  let loggedOut = new URLSearchParams(browser.location.search).get('auth') === 'logged-out';

  const target = () => {
    const search = new URLSearchParams(browser.location.search);
    if (search.get('auth') === 'logged-out') search.delete('auth');
    const query = search.toString();
    return loginUrl(browser.location.pathname + (query ? `?${query}` : ''));
  };

  return {
    automatic(): LoginNavigationState {
      if (navigating) return 'redirecting';
      if (loggedOut) return 'logged-out';
      try {
        if (browser.sessionStorage.getItem(LOGIN_ATTEMPT_KEY)) return 'login';
        browser.sessionStorage.setItem(LOGIN_ATTEMPT_KEY, '1');
      } catch {
        return 'login';
      }
      navigating = true;
      browser.location.replace(target());
      return 'redirecting';
    },
    manual() {
      if (navigating) return;
      try {
        browser.sessionStorage.setItem(LOGIN_ATTEMPT_KEY, '1');
      } catch {
        // Manual login remains available when storage is disabled.
      }
      navigating = true;
      browser.location.replace(target());
    },
    complete() {
      navigating = false;
      loggedOut = false;
      try {
        browser.sessionStorage.removeItem(LOGIN_ATTEMPT_KEY);
      } catch {
        // Server session is valid even if browser storage is unavailable.
      }
    },
  };
}
