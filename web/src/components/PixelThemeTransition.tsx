import { useEffect, useRef } from 'react';

interface PixelThemeTransitionProps {
  /** 切换前的主题背景色 */
  fromColor: string;
  /** 动画完成回调 */
  onComplete: () => void;
}

const DESKTOP_PIXEL_SIZE = 24;
const MOBILE_PIXEL_SIZE = 16;
const TOTAL_DURATION_MS = 1200;

interface Cell {
  col: number;
  row: number;
  x: number;
  y: number;
  revealAt: number;
  fadeDuration: number;
  inset: number;
}

/** 主题切换时的像素块崩解转场覆盖层。 */
export function PixelThemeTransition({ fromColor, onComplete }: PixelThemeTransitionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const pixelSize = viewportWidth <= 599 ? MOBILE_PIXEL_SIZE : DESKTOP_PIXEL_SIZE;

    const cols = Math.ceil(viewportWidth / pixelSize);
    const rows = Math.ceil(viewportHeight / pixelSize);

    // 按 DPR 缩放 canvas，保证物理像素锐利
    canvas.width = viewportWidth * dpr;
    canvas.height = viewportHeight * dpr;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
    ctx.scale(dpr, dpr);

    // 初始铺满旧主题背景色
    ctx.fillStyle = fromColor;
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    const centerCol = (cols - 1) / 2;
    const centerRow = (rows - 1) / 2;
    const maxDistance = Math.sqrt(centerCol * centerCol + centerRow * centerRow) || 1;

    const cells: Cell[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const dx = col - centerCol;
        const dy = row - centerRow;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const normalized = distance / maxDistance;

        // 距离因素占 55%，随机因素占 75%，形成中心优先但边界不规则的侵蚀效果
        const distanceDelay = normalized * TOTAL_DURATION_MS * 0.55;
        const randomDelay = Math.random() * TOTAL_DURATION_MS * 0.75;
        const revealAt = distanceDelay + randomDelay;

        // 单块崩解时长随机，制造错落感
        const fadeDuration = 60 + Math.random() * 160;

        // 块边缘随机内缩 0–2px，像碎裂后的小碎片
        const inset = Math.floor(Math.random() * 3);

        cells.push({
          col,
          row,
          x: col * pixelSize,
          y: row * pixelSize,
          revealAt,
          fadeDuration,
          inset,
        });
      }
    }

    // 按 revealAt 排序，方便顺序加入激活队列
    cells.sort((a, b) => a.revealAt - b.revealAt);

    let rafId = 0;
    let startTime: number | null = null;
    let nextIndex = 0;
    const active = new Set<Cell>();

    const animate = (timestamp: number) => {
      if (startTime === null) startTime = timestamp;
      const elapsed = timestamp - startTime;

      // 把到达崩解时间的块加入激活队列
      while (nextIndex < cells.length && cells[nextIndex].revealAt <= elapsed) {
        active.add(cells[nextIndex]);
        nextIndex++;
      }

      // 用 destination-out 以当前进度擦除每个激活块，实现淡出崩解
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';

      for (const cell of active) {
        const progress = (elapsed - cell.revealAt) / cell.fadeDuration;
        if (progress >= 1) {
          // 已经完全崩解，彻底清空这块区域
          ctx.globalAlpha = 1;
          ctx.clearRect(cell.x, cell.y, pixelSize, pixelSize);
          active.delete(cell);
          continue;
        }

        ctx.globalAlpha = Math.max(0, progress);
        const size = pixelSize - cell.inset * 2;
        if (size > 0) {
          ctx.fillRect(cell.x + cell.inset, cell.y + cell.inset, size, size);
        }
      }

      ctx.restore();

      if (nextIndex < cells.length || active.size > 0) {
        rafId = requestAnimationFrame(animate);
      } else {
        // 多等一帧确保最后一块渲染完成
        rafId = requestAnimationFrame(() => {
          onComplete();
        });
      }
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [fromColor, onComplete]);

  return (
    <div className="pixel-theme-transition" aria-hidden="true" role="presentation">
      <canvas ref={canvasRef} />
    </div>
  );
}
