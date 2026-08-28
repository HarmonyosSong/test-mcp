import { useCallback, useEffect, useState } from 'react';
import { applyTheme, getInitialTheme, type Theme } from '../lib/theme';

export interface UseThemeTransitionResult {
  theme: Theme;
  fromColor: string;
  isTransitioning: boolean;
  toggle: () => void;
  endTransition: () => void;
}

/** 管理主题状态，并在切换时触发像素扩散转场。 */
export function useThemeTransition(): UseThemeTransitionResult {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [fromColor, setFromColor] = useState('#ffffff');
  const [isTransitioning, setIsTransitioning] = useState(false);

  // 防御性同步：React 挂载后确保 html/localStorage 与当前状态一致
  useEffect(() => {
    applyTheme(theme);
  }, []);

  const endTransition = useCallback(() => {
    setIsTransitioning(false);
  }, []);

  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';

    // 切换前先记录旧主题背景色
    const oldColor = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();

    // 立即应用新主题到 DOM 和 localStorage
    applyTheme(next);
    setTheme(next);

    setFromColor(oldColor);

    // 尊重减少动态效果偏好：直接切换，不播放动画
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    setIsTransitioning(true);
  }, [theme]);

  return { theme, fromColor, isTransitioning, toggle, endTransition };
}
