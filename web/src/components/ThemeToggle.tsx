import { Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'harmony-theme';

function getInitialTheme(): Theme {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 浅色/深色主题切换按钮：写 <html data-theme> 并持久化到 localStorage。 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const dark = theme === 'dark';
  return (
    <button
      className="sidebar-icon-button"
      type="button"
      onClick={toggle}
      title={dark ? '切换到浅色主题' : '切换到深色主题'}
      aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
      aria-pressed={dark}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
