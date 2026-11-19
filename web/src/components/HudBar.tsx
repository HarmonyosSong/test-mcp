import { useEffect, useState } from 'react';
import type { ConnectionState, ModelStatus } from '../types';

interface HudBarProps {
  connection: ConnectionState;
  modelStatus: ModelStatus;
}

const CRT_KEY = 'hud-crt';

function readCrt(): boolean {
  try {
    return window.localStorage.getItem(CRT_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** 底部 HUD 状态栏：磷光终端皮肤的一部分，仅 dark 主题下显示（CSS 控制）。 */
export function HudBar({ connection, modelStatus }: HudBarProps) {
  const [now, setNow] = useState(() => new Date());
  const [crt, setCrt] = useState(readCrt);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.crt = crt ? 'on' : 'off';
    try {
      window.localStorage.setItem(CRT_KEY, crt ? 'on' : 'off');
    } catch {
      /* storage disabled */
    }
  }, [crt]);

  const linkOk = connection === 'connected';
  const linkLabel =
    connection === 'connected' ? 'ONLINE' : connection === 'checking' ? 'LINK…' : 'DEMO';
  const modelLabel = modelStatus.configured ? 'MODEL READY' : 'MODEL N/A';
  const clock = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  return (
    <footer className="hud-bar" role="contentinfo">
      <span className="hud-cell">
        <span className="hud-blink" aria-hidden="true">▮</span>
        XESAPP-AGENT<span className="hud-dim">://DIAG-WORKBENCH</span>
      </span>
      <span className="hud-cell">
        <span className="hud-dim">LINK</span>
        <span className={linkOk ? 'hud-link-ok' : 'hud-link-bad'}>{linkLabel}</span>
      </span>
      <span className="hud-cell">
        <span className="hud-dim">MODEL</span>
        {modelLabel}
      </span>
      <span className="hud-spacer" />
      <span className="hud-cell hud-dim">{clock(now)}</span>
      <button
        type="button"
        className="hud-crt-toggle"
        onClick={() => setCrt(v => !v)}
        aria-pressed={crt}
        title={crt ? '关闭 CRT 扫描线' : '开启 CRT 扫描线'}
      >
        CRT:{crt ? 'ON' : 'OFF'}
      </button>
    </footer>
  );
}
