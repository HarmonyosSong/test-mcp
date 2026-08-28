import { Moon, Sun } from 'lucide-react';
import { PixelThemeTransition } from './PixelThemeTransition';
import { useThemeTransition } from '../hooks/useThemeTransition';

/** 浅色/深色主题切换按钮：切换时播放像素块扩散转场。 */
export function ThemeToggle() {
  const { theme, fromColor, isTransitioning, toggle, endTransition } = useThemeTransition();

  const dark = theme === 'dark';

  return (
    <>
      <button
        className="sidebar-icon-button"
        type="button"
        onClick={toggle}
        disabled={isTransitioning}
        title={dark ? '切换到浅色主题' : '切换到深色主题'}
        aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
        aria-pressed={dark}
      >
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      {isTransitioning && (
        <PixelThemeTransition fromColor={fromColor} onComplete={endTransition} />
      )}
    </>
  );
}
