import { useEffect, useState, type CSSProperties } from 'react';
import {
  SUN_BODY_PATHS,
  SUN_DUST,
  SUN_GLOW_FAR,
  SUN_GLOW_NEAR,
  SUN_RAYS,
  SUN_VIEW,
} from './sunSceneData';

/**
 * SunSky —— 日主题天空层：跟随真实时间运行的像素太阳。
 * 6:00 日出（右上低位淡入、微橙）→ 正午爬至最高（大半出血）→ 15:00 起转暖、
 * 18:00 全红夕阳 → 19:00 落下淡出。每 30s 推进一步，CSS transition 负责连续漂移，
 * 肉眼几乎察觉不到在动，但隔一段时间回来太阳位置已经变了。
 * 调试：控制台设置 window.__SUN_TIME__ = 17.5（小时）可锁定任意时刻。
 */

/** 白日色板（与 PixelOrb SUN_PALETTE 同源）→ 夕阳红色板 */
const DAY = {
  lv: ['#c96a18', '#f09724', '#ffc95e', '#fff3cf'],
  glowNear: '#f09724',
  glowFar: '#ffc95e',
  dust: '#c96a18',
  sky: [240, 151, 36],
};
const DUSK = {
  lv: ['#a8281a', '#e0501e', '#ff8a4a', '#ffd9a8'],
  glowNear: '#e8561e',
  glowFar: '#ff9a5c',
  dust: '#b0401e',
  sky: [235, 90, 40],
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function hexLerp(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa
    .map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0'))
    .join('')}`;
}

interface SkyState {
  /** 太阳中心水平位置（容器宽度百分比） */
  x: number;
  /** 太阳中心垂直位置（容器顶部向下 px） */
  y: number;
  /** 0 = 正午金，1 = 夕阳红 */
  heat: number;
  /** 日出日落淡入淡出 */
  visible: number;
}

function readSky(): SkyState {
  const override = (window as unknown as { __SUN_TIME__?: number }).__SUN_TIME__;
  const now = new Date();
  const h = typeof override === 'number' ? override : now.getHours() + now.getMinutes() / 60;
  // 白昼窗口 6:00 - 19:00
  const p = clamp01((h - 6) / 13);
  const x = 88 - 20 * p; // 88% → 68%，超慢左移（东升西落）
  const y = 105 - 135 * Math.sin(Math.PI * p); // 抛物线：低垂 → 正午最高（出血）→ 低垂
  // 15:00 起转暖、18:00 全红；清晨 6:00-7:30 带一点晨曦橙
  const dusk = clamp01((h - 15) / 3);
  const dawn = clamp01(1 - (h - 6) / 1.5) * 0.35;
  const heat = Math.max(dusk, dawn);
  // 日出 45 分钟淡入，日落 45 分钟淡出
  const visible = Math.min(clamp01((h - 5.75) / 0.75), clamp01((19.25 - h) / 0.75));
  return { x, y, heat, visible };
}

export function SunSky() {
  const [sky, setSky] = useState<SkyState>(readSky);

  useEffect(() => {
    const timer = window.setInterval(() => setSky(readSky()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const t = sky.heat;
  const skyRgb = DAY.sky.map((v, i) => Math.round(v + (DUSK.sky[i] - v) * t));
  const vars = {
    '--sun-lv0': hexLerp(DAY.lv[0], DUSK.lv[0], t),
    '--sun-lv1': hexLerp(DAY.lv[1], DUSK.lv[1], t),
    '--sun-lv2': hexLerp(DAY.lv[2], DUSK.lv[2], t),
    '--sun-lv3': hexLerp(DAY.lv[3], DUSK.lv[3], t),
    '--sun-glow-near': hexLerp(DAY.glowNear, DUSK.glowNear, t),
    '--sun-glow-far': hexLerp(DAY.glowFar, DUSK.glowFar, t),
    '--sun-dust': hexLerp(DAY.dust, DUSK.dust, t),
  } as CSSProperties;

  return (
    <div className="sun-sky" style={vars} aria-hidden="true">
      {/* 晨光/暮光全幅晕染：跟随太阳位置与颜色 */}
      <div
        className="sun-sky-tint"
        style={{
          backgroundImage: `radial-gradient(ellipse 46% 38% at ${sky.x.toFixed(2)}% ${(sky.y + 40).toFixed(1)}px, rgba(${skyRgb.join(',')}, 0.13), transparent 70%)`,
          opacity: sky.visible,
        }}
      />
      <svg
        className="sun-sky-body"
        viewBox={`0 0 ${SUN_VIEW.w} ${SUN_VIEW.h}`}
        width={SUN_VIEW.w}
        height={SUN_VIEW.h}
        shapeRendering="crispEdges"
        style={{
          left: `calc(${sky.x.toFixed(2)}% - ${SUN_VIEW.cx}px)`,
          top: `${(sky.y - SUN_VIEW.cy).toFixed(1)}px`,
          opacity: sky.visible,
        }}
      >
        <path className="sun-glow-far" d={SUN_GLOW_FAR} />
        <path className="sun-glow-near" d={SUN_GLOW_NEAR} />
        {SUN_BODY_PATHS.map((d, i) => (
          <path key={i} className={`sun-lv${i}`} d={d} />
        ))}
        {/* 8 道光芒：整组 100s 慢转，各道异相呼吸 */}
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`0 ${SUN_VIEW.cx} ${SUN_VIEW.cy}`}
            to={`360 ${SUN_VIEW.cx} ${SUN_VIEW.cy}`}
            dur="100s"
            repeatCount="indefinite"
          />
          {SUN_RAYS.map((ray, i) => (
            <path key={i} className={ray.hi ? 'sun-ray-hi' : 'sun-ray-lo'} d={ray.d}>
              <animate
                attributeName="opacity"
                values="0.95;0.35;0.95"
                dur={ray.dur}
                begin={ray.begin}
                repeatCount="indefinite"
              />
            </path>
          ))}
        </g>
        {/* 光尘：阳光下漂浮明灭的尘埃 */}
        {SUN_DUST.map((d, i) => (
          <rect key={i} className="sun-dust" x={d.x} y={d.y} width={d.s} height={d.s} opacity={0}>
            <animate
              attributeName="opacity"
              values="0;0.65;0.12;0.55;0"
              dur={d.durO}
              begin={d.begin}
              repeatCount="indefinite"
            />
            <animateTransform
              attributeName="transform"
              type="translate"
              values={`0 0;${d.mx} ${d.my};0 0`}
              dur={d.durT}
              begin={d.begin}
              repeatCount="indefinite"
            />
          </rect>
        ))}
      </svg>
    </div>
  );
}
