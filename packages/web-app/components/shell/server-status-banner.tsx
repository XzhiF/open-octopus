'use client'

import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react'
import type { ServerHealthResult } from '@/hooks/use-server-health'
import { cn } from '@/lib/utils'

/**
 * 壳层顶部的后端异常横幅：server 连不上 / 未就绪时常驻，恢复后自动消失。
 * 在线与首次探测中不占任何高度。
 */
export function ServerStatusBanner({ health }: { health: ServerHealthResult }) {
  if (health.status === 'online' || health.status === 'checking') return null

  const offline = health.status === 'offline'
  const Icon = offline ? WifiOff : AlertTriangle

  return (
    <div
      role="alert"
      data-testid="server-status-banner"
      data-status={health.status}
      className={cn(
        'z-[60] flex h-7 shrink-0 items-center gap-2 border-b-[1.5px] px-2.5 text-[11px]',
        offline
          ? 'border-pop-red/50 bg-pop-red/15 text-pop-red'
          : 'border-pop-amber/50 bg-pop-amber/15 text-pop-amber',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="shrink-0 font-bold">{offline ? '后端服务未连接' : '后端服务异常'}</span>
      <span
        className="min-w-0 truncate font-mono text-[10.5px] opacity-80"
        title={health.serverUrl}
      >
        {health.serverUrl}
      </span>
      <span className="min-w-0 truncate opacity-80">
        {offline
          ? `无响应 · 已重试 ${health.failures} 次 · 正在自动重连…`
          : `${health.detail ?? '服务异常'} · 正在重试…`}
      </span>
      <button
        type="button"
        data-testid="server-status-retry"
        onClick={health.retry}
        className={cn(
          'ml-auto flex shrink-0 items-center gap-1 rounded-[6px] border px-1.5 py-0.5 text-[10.5px] transition-colors',
          offline
            ? 'border-pop-red/60 hover:bg-pop-red/20'
            : 'border-pop-amber/60 hover:bg-pop-amber/20',
        )}
      >
        <RefreshCw className="size-3" />
        立即重试
      </button>
    </div>
  )
}
