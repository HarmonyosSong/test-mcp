import {
  BarChart3,
  LoaderCircle,
  LogOut,
  MessageSquare,
  RefreshCw,
  ScanSearch,
  Settings2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConnectionState } from '../types';
import { ThemeToggle } from './ThemeToggle';
import { Typewriter } from './Typewriter';

export type SidebarNav = 'chat' | 'usage';

interface SidebarProps {
  connection: ConnectionState;
  refreshing: boolean;
  identityLabel?: string;
  activeNav?: SidebarNav;
  onNavigateChat?: () => void;
  onNavigateUsage?: () => void;
  onRefresh: () => void;
  onModelSettings: () => void;
  onLogout?: () => void;
  children?: ReactNode;
}

export function Sidebar({
  connection,
  refreshing,
  identityLabel,
  activeNav = 'chat',
  onNavigateChat,
  onNavigateUsage,
  onRefresh,
  onModelSettings,
  onLogout,
  children,
}: SidebarProps) {
  const connectionLabel =
    connection === 'connected'
      ? '服务已连接'
      : connection === 'demo'
        ? '演示模式'
        : '正在连接';

  return (
    <aside className="app-sidebar" aria-label="侧边导航">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          <ScanSearch size={18} strokeWidth={2} />
        </span>
        <strong>
          <Typewriter text="学而思App诊断工作台" />
        </strong>
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        <button
          type="button"
          className={activeNav === 'chat' ? 'selected' : ''}
          aria-current={activeNav === 'chat' ? 'page' : undefined}
          onClick={onNavigateChat}
        >
          <MessageSquare size={16} />
          <span>聊天</span>
        </button>
        <button
          type="button"
          className={activeNav === 'usage' ? 'selected' : ''}
          aria-current={activeNav === 'usage' ? 'page' : undefined}
          onClick={onNavigateUsage}
        >
          <BarChart3 size={16} />
          <span>使用统计</span>
        </button>
      </nav>

      {activeNav === 'chat' ? <div className="sidebar-content">{children}</div> : <div className="sidebar-content" />}

      <div className="sidebar-footer">
        <span
          className={`sidebar-status sidebar-status-${connection}`}
          title={identityLabel ? `${connectionLabel} · ${identityLabel}` : connectionLabel}
        >
          <span className={`source-dot source-${connection}`} />
          {connection === 'checking' && <LoaderCircle className="spin" size={12} />}
          {identityLabel || connectionLabel}
        </span>
        <div className="sidebar-footer-actions">
          <ThemeToggle />
          <button
            className="sidebar-icon-button"
            type="button"
            onClick={onRefresh}
            title="刷新会话"
            aria-label="刷新会话"
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? 'spin' : ''} size={16} />
          </button>
          <button
            className="sidebar-icon-button"
            type="button"
            onClick={onModelSettings}
            title="模型设置"
            aria-label="打开模型设置"
          >
            <Settings2 size={16} />
          </button>
          {onLogout && (
            <button
              className="sidebar-icon-button"
              type="button"
              onClick={onLogout}
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
