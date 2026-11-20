// 生成「日」主题太阳场景数据：像素太阳本体(Bayer 抖动) + 旋转脉动光芒 + 漂浮光尘
// 输出: web/src/components/sunSceneData.ts（内联 SVG 用；色板与 PixelOrb SUN_PALETTE 同源）
// 用法: node web/scripts/gen-sun-scene.mjs
import fs from 'node:fs';

const W = 640, H = 480;
const CX = 520, CY = 96;      // 太阳中心（在场景画布内的位置）
const R = 65;                 // 太阳本体半径
const GLOW = 105;             // 光晕带宽度
const CELL = 5;               // 像素格尺寸
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// —— 确定性伪随机 ——
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const n00 = hash(x0, y0), n10 = hash(x0 + 1, y0), n01 = hash(x0, y0 + 1), n11 = hash(x0 + 1, y0 + 1);
  return n00 * (1 - sx) * (1 - sy) + n10 * sx * (1 - sy) + n01 * (1 - sx) * sy + n11 * sx * sy;
}
const fbm = (x, y) => noise(x, y) * 0.55 + noise(x * 2.3, y * 2.3) * 0.28 + noise(x * 4.7, y * 4.7) * 0.17;

// —— 像素格按层级分桶，合并为 path ——
const buckets = new Map();
const push = (key, x, y, s) => {
  const d = `M${x} ${y}h${s}v${s}h-${s}z`;
  const arr = buckets.get(key);
  if (arr) arr.push(d); else buckets.set(key, [d]);
};

// —— 太阳本体 + Bayer 光晕 ——
for (let gy = 0; gy * CELL < H; gy++) {
  for (let gx = 0; gx * CELL < W; gx++) {
    const x = gx * CELL, y = gy * CELL;
    const px = x + CELL / 2, py = y + CELL / 2;
    const d = Math.hypot(px - CX, py - CY);
    const b = (BAYER[(gy & 3) * 4 + (gx & 3)] + 0.5) / 16;
    if (d <= R) {
      // 与 PixelOrb 太阳同一公式：核心亮、边缘深，FBM 表面纹理
      const F = 1.05 - (d / R) * 0.78 + (fbm(px / 24, py / 24) - 0.5) * 0.42;
      const lv = Math.min(3, Math.max(0, Math.floor((F + (b - 0.5) * 0.3) * 4)));
      push(`lv${lv}`, x, y, CELL);
    } else if (d <= R + GLOW) {
      const t = (d - R) / GLOW;
      const F = Math.pow(1 - t, 1.75) * 0.92;
      if (F > b) push(t < 0.42 ? 'glowNear' : 'glowFar', x, y, CELL);
    }
  }
}

// —— 光芒：8 道、长短交替；各道异相呼吸 ——
const rays = [];
const rand = mulberry32(7);
for (let i = 0; i < 8; i++) {
  const a = (i * Math.PI) / 4;
  const dx = Math.cos(a), dy = Math.sin(a);
  const len = i % 2 === 0 ? 5 : 3;
  const start = R + 14;
  let d = '';
  for (let k = 0; k < len; k++) {
    const dist = start + k * CELL;
    const x = Math.round((CX + dx * dist) / CELL) * CELL;
    const y = Math.round((CY + dy * dist) / CELL) * CELL;
    d += `M${x} ${y}h${CELL}v${CELL}h-${CELL}z`;
  }
  rays.push({
    d,
    hi: i % 2 === 0,
    dur: `${(2.8 + rand() * 2.2).toFixed(1)}s`,
    begin: `${(-rand() * 4).toFixed(1)}s`,
  });
}

// —— 光尘：阳光下漂浮的尘埃颗粒，缓慢漂移 + 明灭 ——
const dust = [];
let guard = 0;
while (dust.length < 14 && guard++ < 300) {
  const x = Math.round(30 + rand() * (W - 90));
  const y = Math.round(24 + rand() * (H - 60));
  if (Math.hypot(x - CX, y - CY) < R + GLOW + 26) continue; // 别压太阳
  dust.push({
    x, y,
    s: [3, 4, 4, 5][Math.floor(rand() * 4)],
    durO: `${(5 + rand() * 8).toFixed(1)}s`,
    durT: `${(9 + rand() * 9).toFixed(1)}s`,
    begin: `${(-rand() * 10).toFixed(1)}s`,
    mx: +(rand() * 14 - 7).toFixed(0),
    my: +(rand() * 12 - 9).toFixed(0),
  });
}

const ts = `/* eslint-disable */
// 本文件由 scripts/gen-sun-scene.mjs 生成，请勿手改；调整参数后重新运行生成器。
export const SUN_VIEW = { w: ${W}, h: ${H}, cx: ${CX}, cy: ${CY}, r: ${R} } as const;

/** 太阳本体四级色（索引 0 = 最外缘，3 = 核心高光），fill 由 SunSky 按时间注入 */
export const SUN_BODY_PATHS = [
  '${buckets.get('lv0')?.join('') || ''}',
  '${buckets.get('lv1')?.join('') || ''}',
  '${buckets.get('lv2')?.join('') || ''}',
  '${buckets.get('lv3')?.join('') || ''}',
] as const;

export const SUN_GLOW_NEAR = '${buckets.get('glowNear')?.join('') || ''}';
export const SUN_GLOW_FAR = '${buckets.get('glowFar')?.join('') || ''}';

export interface SunRay {
  d: string;
  /** hi=true 长芒（用主色），false = 短芒（用亮色） */
  hi: boolean;
  dur: string;
  begin: string;
}

export const SUN_RAYS: SunRay[] = ${JSON.stringify(rays, null, 2)};

export interface SunDust {
  x: number;
  y: number;
  s: number;
  durO: string;
  durT: string;
  begin: string;
  mx: number;
  my: number;
}

export const SUN_DUST: SunDust[] = ${JSON.stringify(dust, null, 2)};
`;

const target = new URL('../src/components/sunSceneData.ts', import.meta.url);
fs.writeFileSync(target, ts);
console.log('written:', target.pathname, 'bytes:', Buffer.byteLength(ts));
