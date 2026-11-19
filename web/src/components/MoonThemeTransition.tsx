import { useEffect, useRef } from 'react';

interface MoonThemeTransitionProps {
  /** 切换前的主题背景色 */
  fromColor: string;
  /** 目标主题：dark 播月亮（暗面→满月），light 播太阳（点燃 → 放射光芒） */
  target: 'light' | 'dark';
  /** 动画完成回调 */
  onComplete: () => void;
}

const TOTAL_MS = 1150;
const PHASE_RATIO = 0.58; // 前段：月相/日出；后段：放大吞屏
const PIXEL = 4; // 低分辨率缓冲的像素粒度（careers.kimi.com 同款 4px）
const LEVELS = 6;
/** 月：单色灰阶 */
const MOON_PALETTE = ['#0a0a0a', '#2e2e2e', '#5c5c5c', '#8a8a8a', '#c8c8c8', '#f5f5f5'];
/** 日：暖橙光谱 */
const SUN_PALETTE = ['#3a1c05', '#7a3c0e', '#c96a18', '#f09724', '#ffc95e', '#fff3cf'];
const BAYER4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

/** 确定性 PRNG */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 多倍频 value-noise 纹理（权重参考官网：.5/.28/.16/.1/.07/.05） */
function makeNoiseTexture(size: number): Float32Array {
  const rand = mulberry32(42);
  const octaves = [8, 16, 32, 64, 128, 256];
  const weights = [0.5, 0.28, 0.16, 0.1, 0.07, 0.05];
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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** 8 道光芒方向（先主轴后对角线，阶梯式长出更有机械感） */
const RAY_DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [-1, 1], [1, -1], [-1, -1],
];

export function MoonThemeTransition({ fromColor, target, onComplete }: MoonThemeTransitionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 低分辨率缓冲 + 最近邻放大 = 像素颗粒感
    const bw = Math.ceil(vw / PIXEL);
    const bh = Math.ceil(vh / PIXEL);
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    canvas.style.imageRendering = 'pixelated';
    ctx.imageSmoothingEnabled = false;

    const tex = makeNoiseTexture(128);
    const isSun = target === 'light';
    const palette = isSun ? SUN_PALETTE : MOON_PALETTE;
    const cx = bw / 2;
    const cy = bh / 2;
    const bodyR = Math.min(bw, bh) * 0.22;
    const coverR = Math.hypot(bw, bh) / 2 + 2;

    // 月亮光源方向（参考官网 sunAngle 35°，带前向分量产生球面明暗）
    const sun = (35 * Math.PI) / 180;
    const llen = Math.hypot(Math.cos(sun), Math.sin(sun) * 0.35, 0.9);
    const Lx = Math.cos(sun) / llen;
    const Ly = (Math.sin(sun) * 0.35) / llen;
    const Lz = 0.9 / llen;

    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

    const texAt = (x: number, y: number) =>
      tex[(((y % 128) + 128) % 128) * 128 + (((x % 128) + 128) % 128)];

    const ditherQuantize = (F: number, x: number, y: number) => {
      F += ((BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * (0.6 / LEVELS);
      return Math.min(LEVELS - 1, Math.max(0, Math.round(F * (LEVELS - 1))));
    };

    /** 画一帧：progress 为月相/日出进度，r 为天体半径（缓冲像素） */
    const drawFrame = (overlayAlpha: number, progress: number, r: number) => {
      ctx.clearRect(0, 0, bw, bh);
      ctx.globalAlpha = overlayAlpha;
      ctx.fillStyle = fromColor;
      ctx.fillRect(0, 0, bw, bh);
      ctx.globalAlpha = 1;
      if (r < 1) return;

      const buckets = new Map<string, number[]>();
      const push = (level: number, x: number, y: number) => {
        if (level <= 0 || x < 0 || y < 0 || x >= bw || y >= bh) return;
        const color = palette[level];
        const arr = buckets.get(color);
        if (arr) arr.push(x, y);
        else buckets.set(color, [x, y]);
      };

      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(bw - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(bh - 1, Math.ceil(cy + r));

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / r;
          const dy = (y - cy) / r;
          const d2 = dx * dx + dy * dy;
          if (d2 > 1) continue;
          const M = texAt(x, y);

          if (isSun) {
            // 太阳：从中心向外点燃（径向梯度 + 纹理翻滚）
            const d = Math.sqrt(d2);
            const F = clamp01(progress * 1.35 - d * 0.9 + (M - 0.5) * 0.35);
            push(ditherQuantize(F, x, y), x, y);
          } else {
            // 月亮：明暗界线横扫月面（暗面 → 亮面，官网同款三段曲线）
            const nz = Math.sqrt(1 - d2);
            let C = dx * Lx + dy * Ly + nz * Lz;
            C += (progress - 0.5) * 2;
            const O =
              C <= -0.18 ? 0
              : C >= 0.18 ? 0.85 * Math.min(1, (C - 0.18) / 0.82) + 0.15
              : 0.15 * smooth((C + 0.18) / 0.36);
            if (O <= 0) continue; // 暗面不画，透出旧色 = 隐形的新月
            let F = (0.24 + (M - 0.24) * clamp01((O - 0.2) / 0.22)) * O;
            F *= 0.85 + 0.15 * nz;
            push(ditherQuantize(F, x, y), x, y);
          }
        }
      }

      // 太阳光芒：8 道阶梯式长出（仅在日出段结束后、吞屏前可见）
      if (isSun) {
        const rayLen = Math.floor(bodyR * 0.9 * clamp01(progress * 1.4 - 0.4));
        const rayStart = Math.floor(r) + 1;
        RAY_DIRS.forEach(([rdx, rdy], ri) => {
          // 光芒逐条点亮：主軸先亮，对角线后亮
          const delay = ri < 4 ? 0 : 2;
          const len = Math.max(0, rayLen - delay * 2);
          for (let k = 0; k < len; k++) {
            const fade = 1 - k / Math.max(len, 1);
            const level = ditherQuantize(0.4 + fade * 0.6, ri * 7 + k, k * 3 + ri);
            // 2px 宽光芒
            const bx = Math.round(cx + (rayStart + k) * RAY_DIRS[ri][0]);
            const by = Math.round(cy + (rayStart + k) * RAY_DIRS[ri][1]);
            const ox = rdy !== 0 ? 1 : 0; // 垂直光芒横向加宽
            const oy = rdx !== 0 ? 1 : 0; // 水平光芒纵向加宽
            push(level, bx, by);
            push(level, bx + ox, by + oy);
          }
        });
      }

      ctx.globalAlpha = overlayAlpha;
      for (const [color, pts] of buckets) {
        ctx.fillStyle = color;
        for (let i = 0; i < pts.length; i += 2) {
          ctx.fillRect(pts[i], pts[i + 1], 1, 1);
        }
      }
      ctx.globalAlpha = 1;
    };

    let rafId = 0;
    let start: number | null = null;

    const frame = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min((ts - start) / TOTAL_MS, 1);

      if (t < PHASE_RATIO) {
        drawFrame(1, easeInOut(t / PHASE_RATIO), bodyR);
      } else {
        const g = easeInOut((t - PHASE_RATIO) / (1 - PHASE_RATIO));
        const r = bodyR + (coverR - bodyR) * g;
        // 放大吞屏；最后 1/3 整体淡出，露出新主题
        const fade = g < 0.66 ? 1 : 1 - (g - 0.66) / 0.34;
        drawFrame(fade, 1, r);
      }

      if (t < 1) rafId = requestAnimationFrame(frame);
      else rafId = requestAnimationFrame(() => onComplete());
    };

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, [fromColor, target, onComplete]);

  return (
    <div className="pixel-theme-transition" aria-hidden="true" role="presentation">
      <canvas ref={canvasRef} />
    </div>
  );
}
