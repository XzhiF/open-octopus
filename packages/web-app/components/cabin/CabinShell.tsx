'use client'

// 作战舱兄弟壳（原型 body）：DesktopHeader（复用顶栏）+ 舱 chat tab
// （CabinChatHost = 原 ChatSidebar 三段 + chat 底座 + 作业坞舱模块 + 浮窗层）。
// /cabin/new 渲染 S1 新建向导。没有独立左轨 —— 原型左侧就是生产侧栏加作战舱段。

import { DesktopHeader } from '@/components/layout/desktop-header'
import { useRouter } from '@/lib/app-navigation'
import { CabinProvider, useCabinContext } from './cabin-provider'
import { CockpitProvider } from './CockpitProvider'
import { CabinChatHost } from './CabinChatHost'
import { CabinNewHero } from './CabinNewHero'
import { CabinWinstrip } from './CabinModulesLayer'

export function CabinShell({ cabinId }: { cabinId: string }) {
  if (cabinId === 'new') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DesktopHeader />
        <CabinNewHero />
      </div>
    )
  }
  if (!cabinId) {
    return <CabinMissing message="缺少舱 id" />
  }
  return (
    // key = 舱 id：深链换舱（/cabin/a → /cabin/b）也整舱重挂，形象状态不跨舱。
    <CabinProvider cabinId={cabinId} key={cabinId}>
      <CabinShellInner />
    </CabinProvider>
  )
}

function CabinShellInner() {
  const { cabin, loading, error } = useCabinContext()

  if (loading) {
    return (
      <div className="grid flex-1 place-items-center bg-pop-bg text-sm text-pop-dim" data-testid="cabin-loading">
        载入舱…
      </div>
    )
  }
  if (!cabin) {
    return <CabinMissing message={error === 'not-found' ? '舱不存在或已被删除' : (error ?? '舱加载失败')} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DesktopHeader extraStrip={<CabinWinstrip />} />
      <CockpitProvider>
        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-pop-bg" data-testid="cabin-stage">
          <CabinChatHost />
        </div>
      </CockpitProvider>
    </div>
  )
}

function CabinMissing({ message }: { message: string }) {
  const router = useRouter()
  return (
    <div className="grid flex-1 place-items-center bg-pop-bg" data-testid="cabin-missing">
      <div className="text-center">
        <div className="text-[14px] font-bold text-pop-ink">{message}</div>
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => router.push('/')}
            className="rounded-md border-[1.5px] border-pop-bd px-3 py-1.5 text-[12px] font-bold text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
          >
            返回桌面
          </button>
          <button
            type="button"
            onClick={() => router.push('/cabin/new')}
            className="rounded-md border-[1.5px] border-pop-bd bg-pop-yellow px-3 py-1.5 text-[12px] font-bold text-pop-bg transition-opacity hover:opacity-90"
          >
            新建作战舱
          </button>
        </div>
      </div>
    </div>
  )
}