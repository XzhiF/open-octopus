'use client'

// 桌面壳内的舱宿主（2026-11-13）：
// 与 /cabin/:id 兄弟壳（CabinShell）复用同一套 CabinProvider + CockpitProvider +
// CabinChatHost，但不再渲染自己的 DesktopHeader —— 顶栏仍归 Desktop，
// 桌面窗口/分屏/任务模块照常可用。
//
// 顶部一条舱条：舱身份 + 状态 + 最小化模块（CabinWinstrip）+ 「← 对话」退出。
// 退出只清 CabinMode 状态，不改路由（URL 始终停在 /）。

import { ArrowLeft, Container } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CabinProvider, useCabinContext } from './cabin-provider'
import { CockpitProvider } from './CockpitProvider'
import { CabinChatHost } from './CabinChatHost'
import { CabinWinstrip } from './CabinModulesLayer'
import { CABIN_STATUS_META } from './cabin-meta'

export interface CabinDesktopHostProps {
  cabinId: string
  onExit: () => void
  onSelectCabin: (id: string) => void
  onCreateCabin: () => void
}

export function CabinDesktopHost(props: CabinDesktopHostProps) {
  return (
    <CabinProvider cabinId={props.cabinId}>
      <CockpitProvider>
        <CabinDesktopBody onExit={props.onExit} onSelectCabin={props.onSelectCabin} onCreateCabin={props.onCreateCabin} />
      </CockpitProvider>
    </CabinProvider>
  )
}

function CabinDesktopBody({
  onExit,
  onSelectCabin,
  onCreateCabin,
}: {
  onExit: () => void
  onSelectCabin: (id: string) => void
  onCreateCabin: () => void
}) {
  const { cabin, loading, error } = useCabinContext()

  if (loading) {
    return (
      <div className="grid h-full place-items-center bg-pop-bg text-sm text-pop-dim" data-testid="cabin-loading">
        载入舱…
      </div>
    )
  }
  if (!cabin) {
    return (
      <div className="grid h-full place-items-center bg-pop-bg" data-testid="cabin-missing">
        <div className="text-center">
          <div className="text-[14px] font-bold text-pop-ink">
            {error === 'not-found' ? '舱不存在或已被删除' : (error ?? '舱加载失败')}
          </div>
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={onExit}
              className="rounded-md border-[1.5px] border-pop-bd px-3 py-1.5 text-[12px] font-bold text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
            >
              返回对话
            </button>
            <button
              type="button"
              onClick={onCreateCabin}
              className="rounded-md border-[1.5px] border-pop-bd bg-pop-yellow px-3 py-1.5 text-[12px] font-bold text-pop-bg transition-opacity hover:opacity-90"
            >
              新建作战舱
            </button>
          </div>
        </div>
      </div>
    )
  }

  const meta = CABIN_STATUS_META[cabin.status]

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cabin-desktop-host">
      <div
        data-shell-chrome
        className="flex h-8 shrink-0 items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-2"
      >
        <Container className="size-3.5 shrink-0 text-pop-yellow" strokeWidth={1.9} />
        <span className="min-w-0 truncate text-[12px] font-bold text-pop-ink">{cabin.name}</span>
        <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
        <span className="shrink-0 text-[10px] font-bold text-pop-dim">{meta.label}</span>
        <span className="hidden min-w-0 flex-1 truncate font-mono text-[10px] text-pop-dim/60 sm:block">
          {cabin.path}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <CabinWinstrip />
          <button
            type="button"
            onClick={onExit}
            data-testid="cabin-exit"
            title="回到普通对话"
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-bold text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
          >
            <ArrowLeft className="size-3.5" />
            对话
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-pop-bg" data-testid="cabin-stage">
        <CabinChatHost onSelectCabin={onSelectCabin} onCreateCabin={onCreateCabin} />
      </div>
    </div>
  )
}
