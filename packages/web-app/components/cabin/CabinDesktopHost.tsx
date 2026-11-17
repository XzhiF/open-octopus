'use client'

// 桌面壳内的舱宿主（2026-11-13）：
// 与 /cabin/:id 兄弟壳（CabinShell）复用同一套 CabinProvider + CockpitProvider +
// CabinChatHost，但不再渲染自己的 DesktopHeader —— 顶栏仍归 Desktop，
// 桌面窗口/分屏/任务模块照常可用。
//
// 2026-11-14 用户口径：舱身份条（舱名 / 状态 / 路径 / 「← 对话」）是多余的 ——
// 左栏的作战舱行已经承担身份，退出改为左栏作战舱段的小箭头；这里不再有第二条横条。
// 被最小化的舱模块窗可从坞里重开（openModule 会解除最小化）。

import { CabinProvider, useCabinContext } from './cabin-provider'
import { CockpitProvider } from './CockpitProvider'
import { CabinChatHost } from './CabinChatHost'

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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="cabin-desktop-host">
      <div className="relative flex min-h-0 flex-1 overflow-hidden bg-pop-bg" data-testid="cabin-stage">
        <CabinChatHost
          onSelectCabin={onSelectCabin}
          onCreateCabin={onCreateCabin}
          onExitCabin={onExit}
        />
      </div>
    </div>
  )
}
