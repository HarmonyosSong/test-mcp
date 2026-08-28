import { useEffect, useRef } from 'react';
import gsap from 'gsap';

interface TypewriterProps {
  text: string;
  className?: string;
  /** 每个字符的间隔秒数 */
  speed?: number;
}

/** 打字机效果：逐字显示文本，尾部带闪烁方块光标。 */
export function Typewriter({ text, className, speed = 0.12 }: TypewriterProps) {
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const state = { count: 0 };
    const tween = gsap.to(state, {
      count: text.length,
      duration: text.length * speed,
      ease: 'none',
      onUpdate: () => {
        el.textContent = text.slice(0, Math.round(state.count));
      },
    });
    return () => {
      tween.kill();
    };
  }, [text, speed]);

  return (
    <span className={className}>
      <span ref={textRef} aria-label={text} />
      <span className="typewriter-caret" aria-hidden="true" />
    </span>
  );
}
