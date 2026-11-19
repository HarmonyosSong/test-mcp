import { useEffect, useRef, useState } from 'react';

/**
 * PixelOrb —— 像素日月按钮图标。
 * 与 MoonThemeTransition 同款渲染引擎：低分辨率缓冲 + Bayer 抖动 + 分桶填色。
 * 亮色主题显示太阳（旋转光芒），暗色主题显示月亮（固定光源、月面纹理自转）。
 * active（agent 思考中）时高速旋转，空闲时极慢速 drift。
 */

const SIZE = 28; // 缓冲分辨率（1 格 = 1 屏幕像素 @1x，CSS 等比放大）
const LEVELS = 6;
const MOON_PALETTE = ['#0a0a0a', '#2e2e2e', '#5c5c5c', '#8a8a8a', '#c8c8c8', '#f5f5f5'];
const SUN_PALETTE = ['#3a1c05', '#7a3c0e', '#c96a18', '#f09724', '#ffc95e', '#fff3cf'];
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoiseTexture(size: number): Float32Array {
  const rand = mulberry32(42);
  const octaves = [4, 8, 16, 32];
  const weights = [0.5, 0.28, 0.16, 0.1];
  const total = weights.reduce((a, b) => a + b, 0);
  const out = new Float32Array(size * size);
  for (let o = 0; o < octaves.length; o++) {
    const n = Math.min(octaves[o], size);
    const grid = new Float32Array((n + 1) * (n + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    const w = weights[o] / total;
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * n;
      const y0 = Math.floor(gy);
      const fy = gy - y0;
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * n;
        const x0 = Math.floor(gx);
        const fx = gx - x0;
        const i00 = grid[y0 * (n + 1) + x0];
        const i10 = grid[y0 * (n + 1) + x0 + 1];
        const i01 = grid[(y0 + 1) * (n + 1) + x0];
        const i11 = grid[(y0 + 1) * (n + 1) + x0 + 1];
        out[y * size + x] +=
          w * ((i00 * (1 - fx) + i10 * fx) * (1 - fy) + (i01 * (1 - fx) + i11 * fx) * fy);
      }
    }
  }
  return out;
}

const TEX_SIZE = 64;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

// 月亮光源（与转场动画一致，固定方向 → 自转的是月面纹理）
const sunA = (35 * Math.PI) / 180;
const llen = Math.hypot(Math.cos(sunA), Math.sin(sunA) * 0.35, 0.9);
const LX = Math.cos(sunA) / llen;
const LY = (Math.sin(sunA) * 0.35) / llen;
const LZ = 0.9 / llen;

type ThemeName = 'light' | 'dark';

/** 月亮周围的星星：确定性位置（避开月面），各自带闪烁相位 */
const STAR_SEED = mulberry32(7);
const STARS: { x: number; y: number; phase: number; cross: boolean }[] = (() => {
  const list: { x: number; y: number; phase: number; cross: boolean }[] = [];
  const bodyR = SIZE * 0.33;
  let guard = 0;
  while (list.length < 7 && guard++ < 200) {
    const x = Math.floor(STAR_SEED() * SIZE);
    const y = Math.floor(STAR_SEED() * SIZE);
    const d = Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);
    if (d < bodyR + 2.5) continue; // 别压在月面上
    if (list.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) < 3)) continue;
    list.push({ x, y, phase: STAR_SEED() * Math.PI * 2, cross: STAR_SEED() > 0.6 });
  }
  return list;
})();

function readTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** 订阅 <html data-theme> 变化 */
function useThemeAttr(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(readTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

interface PixelOrbProps {
  /** agent 思考中：高速旋转 */
  active?: boolean;
  /** CSS 显示尺寸（px） */
  size?: number;
}

export function PixelOrb({ active = false, size = 20 }: PixelOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useThemeAttr();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    canvas.width = SIZE;
    canvas.height = SIZE;
    ctx.imageSmoothingEnabled = false;

    const tex = makeNoiseTexture(TEX_SIZE);
    const texAt = (x: number, y: number) =>
      tex[(((y % TEX_SIZE) + TEX_SIZE) % TEX_SIZE) * TEX_SIZE + (((x % TEX_SIZE) + TEX_SIZE) % TEX_SIZE)];
    const ditherQuantize = (F: number, x: number, y: number) => {
      F += ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * (0.6 / LEVELS);
      return Math.min(LEVELS - 1, Math.max(0, Math.round(F * (LEVELS - 1))));
    };

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const isSun = theme === 'light';
    const palette = isSun ? SUN_PALETTE : MOON_PALETTE;
    const bodyR = isSun ? SIZE * 0.26 : SIZE * 0.33;

    const draw = (angle: number, now: number) => {
      ctx.clearRect(0, 0, SIZE, SIZE);
      const buckets = new Map<string, number[]>();
      const push = (level: number, x: number, y: number) => {
        if (level <= 0 || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
        const color = palette[level];
        const arr = buckets.get(color);
        if (arr) arr.push(x, y);
        else buckets.set(color, [x, y]);
      };

      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const x0 = Math.max(0, Math.floor(cx - bodyR - 1));
      const x1 = Math.min(SIZE - 1, Math.ceil(cx + bodyR + 1));
      const y0 = Math.max(0, Math.floor(cy - bodyR - 1));
      const y1 = Math.min(SIZE - 1, Math.ceil(cy + bodyR + 1));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x + 0.5 - cx) / bodyR;
          const dy = (y + 0.5 - cy) / bodyR;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1) continue;
          // 纹理随角度自转
          const rx = dx * cosA - dy * sinA;
          const ry = dx * sinA + dy * cosA;
          const M = texAt(Math.round(rx * 26 + TEX_SIZE / 2), Math.round(ry * 26 + TEX_SIZE / 2));

          if (isSun) {
            const d = Math.sqrt(d2);
            const F = clamp01(1.05 - d * 0.75 + (M - 0.5) * 0.4);
            push(ditherQuantize(F, x, y), x, y);
          } else {
            const nz = Math.sqrt(1 - d2);
            const C = dx * LX + dy * LY + nz * LZ + 0.5; // 大半受光的凸月
            const O =
              C <= -0.18 ? 0
              : C >= 0.18 ? 0.85 * Math.min(1, (C - 0.18) / 0.82) + 0.15
              : 0.15 * smooth((C + 0.18) / 0.36);
            if (O <= 0) continue;
            let F = (0.24 + (M - 0.24) * clamp01((O - 0.2) / 0.22)) * O;
            F *= 0.85 + 0.15 * nz;
            push(ditherQuantize(F, x, y), x, y);
          }
        }
      }

      // 太阳光芒：8 道，随角度旋转；active 时长度脉动
      if (isSun) {
        const pulse = active ? Math.sin(now / 130) * 1.2 : 0;
        for (let i = 0; i < 8; i++) {
          const a = angle + (i * Math.PI) / 4;
          const rdx = Math.cos(a);
          const rdy = Math.sin(a);
          const len = Math.max(2, Math.round((i % 2 === 0 ? 4 : 3) + pulse));
          const start = Math.ceil(bodyR) + 2;
          for (let k = 0; k < len; k++) {
            const fade = 1 - k / len;
            const level = ditherQuantize(0.45 + fade * 0.55, i * 5 + k, k * 3 + i);
            push(level, Math.round(cx + rdx * (start + k)), Math.round(cy + rdy * (start + k)));
          }
        }
      } else {
        // 月亮周围的闪烁星星（十字大星 + 点星）
        for (const star of STARS) {
          const tw = 0.5 + 0.5 * Math.sin(now / 420 + star.phase);
          if (tw < 0.25) continue; // 熄灭期
          const level = ditherQuantize(0.35 + tw * 0.65, star.x, star.y);
          push(level, star.x, star.y);
          if (star.cross && tw > 0.72) {
            const arm = Math.max(2, level - 1);
            push(arm, star.x - 1, star.y);
            push(arm, star.x + 1, star.y);
            push(arm, star.x, star.y - 1);
            push(arm, star.x, star.y + 1);
          }
        }
      }

      for (const [color, pts] of buckets) {
        ctx.fillStyle = color;
        for (let i = 0; i < pts.length; i += 2) {
          ctx.fillRect(pts[i], pts[i + 1], 1, 1);
        }
      }
    };

    let rafId = 0;
    let angle = 0;
    let speed = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // 思考中 ≈ 1.1s/圈；空闲 ≈ 40s/圈（几乎静止但有活气）
      const targetSpeed = active ? 5.6 : 0.16;
      speed += (targetSpeed - speed) * Math.min(1, dt * 5);
      angle += speed * dt;
      draw(angle, now);
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [theme, active]);

  return (
    <canvas
      ref={canvasRef}
      className="pixel-orb"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
