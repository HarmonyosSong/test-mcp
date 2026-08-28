export type Theme = 'light' | 'dark';

export const STORAGE_KEY = 'harmony-theme';

/** 从 localStorage 或系统偏好读取初始主题，与 index.html 内联脚本保持一致。 */
export function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 立即应用主题：同步到 <html data-theme>、localStorage 和 theme-color meta。 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', theme === 'dark' ? '#121212' : '#ffffff');
  }
}
