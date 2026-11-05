import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiPath } from './paths';
import { createLoginNavigation, type LoginNavigationState } from './login-navigation';
import {
  ACCESS_DENIED_EVENT,
  SESSION_EXPIRED_EVENT,
  authenticatedFetch,
  clearSessionClientState,
  setCsrfToken,
} from './session-fetch';

export interface ServerSession {
  authMode: 'sso';
  csrfToken: string;
  identity: {
    subject: string;
    displayName: string;
    issuer: string;
  };
}

const SessionContext = createContext<ServerSession | null>(null);

export function useServerSession() {
  return useContext(SessionContext);
}

type GateState = 'loading' | 'ready' | 'denied' | 'error' | 'unconfigured' | LoginNavigationState;

async function fetchSession(): Promise<ServerSession> {
  const response = await authenticatedFetch(apiPath('/session'));
  if (!response.ok) {
    const error = new Error(`session ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const body = (await response.json()) as ServerSession;
  if (!body?.csrfToken || !body.identity?.subject) {
    throw new Error('invalid session payload');
  }
  return body;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ServerSession | null>(null);
  const [state, setState] = useState<GateState>('loading');
  const navigation = useRef<ReturnType<typeof createLoginNavigation> | null>(null);

  useEffect(() => {
    // SSO cookies are host-only. localhost and 127.0.0.1 are different sites;
    // keep the browser on 127.0.0.1 to match HARMONY_AGENT_PUBLIC_BASE_URL / platform callback.
    if (window.location.hostname === 'localhost') {
      const next = new URL(window.location.href);
      next.hostname = '127.0.0.1';
      window.location.replace(next.toString());
      return;
    }

    const loginNavigation = (navigation.current ??= createLoginNavigation(window));
    if (new URLSearchParams(window.location.search).get('auth') === 'logged-out') {
      clearSessionClientState();
    }

    let active = true;
    const expire = () => {
      active = false;
      clearSessionClientState();
      setSession(null);
      setState(loginNavigation.automatic());
    };
    const deny = () => {
      console.warn('当前账号无权执行此操作');
    };

    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    window.addEventListener(ACCESS_DENIED_EVENT, deny);

    fetchSession()
      .then((value) => {
        if (!active) return;
        loginNavigation.complete();
        setCsrfToken(value.csrfToken);
        setSession(value);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        const status =
          typeof error === 'object' && error && 'status' in error
            ? Number((error as { status?: number }).status)
            : undefined;
        setState(
          status === 403 ? 'denied' : status === 503 ? 'unconfigured' : 'error',
        );
      });

    return () => {
      active = false;
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
      window.removeEventListener(ACCESS_DENIED_EVENT, deny);
    };
  }, []);

  if (state === 'ready' && session) {
    return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
  }

  return (
    <main className="chat-guide" role="status" style={{ minHeight: '100vh' }}>
      <h2>
        {state === 'loading'
          ? '正在验证登录状态…'
          : state === 'redirecting'
            ? '正在跳转企业登录…'
            : state === 'logged-out'
              ? '已退出登录'
              : state === 'login'
                ? '登录未完成，请重试'
                : state === 'denied'
                  ? '当前账号无权访问，请联系管理员'
                  : state === 'unconfigured'
                    ? '登录配置尚未完成，请联系管理员'
                    : '加载登录状态失败，请重试'}
      </h2>
      {(state === 'login' || state === 'logged-out' || state === 'error') && (
        <button
          type="button"
          className="primary-button"
          onClick={() => navigation.current?.manual()}
        >
          企业 SSO 登录
        </button>
      )}
    </main>
  );
}
