import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import type { IncomingMessage } from 'node:http';

const APP_PREFIX = '/xesapp-agent';

function ensureSecureSetCookie(proxyRes: IncomingMessage) {
  const raw = proxyRes.headers['set-cookie'];
  if (!raw) return;
  const cookies = Array.isArray(raw) ? raw : [raw];
  proxyRes.headers['set-cookie'] = cookies.map((cookie) => {
    let next = cookie;
    if (!/;\s*Secure/i.test(next)) next += '; Secure';
    next = next.replace(/;\s*Domain=[^;]*/gi, '');
    return next;
  });
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000';
  const certPath = env.VITE_DEV_HTTPS_CERT
    ? path.resolve(process.cwd(), env.VITE_DEV_HTTPS_CERT)
    : '';
  const keyPath = env.VITE_DEV_HTTPS_KEY
    ? path.resolve(process.cwd(), env.VITE_DEV_HTTPS_KEY)
    : '';
  const https =
    certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)
      ? {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        }
      : undefined;

  const authApiProxy: ProxyOptions = {
    target: proxyTarget,
    changeOrigin: true,
    configure: https
      ? (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            ensureSecureSetCookie(proxyRes);
          });
        }
      : undefined,
  };

  // Bind 127.0.0.1 (not localhost) so printed/open URLs match SSO PUBLIC_BASE_URL and cookies.
  const devOrigin = `${https ? 'https' : 'http'}://127.0.0.1:5174`;

  return {
    base: `${APP_PREFIX}/`,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5174,
      strictPort: true,
      https,
      open: `${devOrigin}${APP_PREFIX}/`,
      proxy: {
        [`${APP_PREFIX}/api`]: authApiProxy,
        [`${APP_PREFIX}/auth`]: authApiProxy,
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      https,
    },
  };
});
