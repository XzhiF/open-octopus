'use client'

import { Suspense } from 'react'
import { AppNavProvider, useAppNavigation } from '@/lib/app-navigation'
import { DesktopWindowsProvider } from '@/lib/desktop-windows'
import { CabinShellRoute } from '@/lib/route-components'
import { Desktop } from '@/components/shell/desktop'
import { ServerStatusBanner } from '@/components/shell/server-status-banner'
import { Toaster } from '@/components/ui/sonner'
import { useServerHealth } from '@/hooks/use-server-health'
import { ChatSessionsProvider } from './chat-sessions'

/**
 * Desktop shell: the chat is the bottom layer, apps are floating windows,
 * and a single global header owns the app menu / window strip / Mission Control.
 *
 * 工作舱（Cabin）是兄弟壳：/cabin/:cabinId 在同一 provider 栈内改渲染
 * CabinShell —— 共享会话/窗口 providers，不是桌面浮窗。
 */
export function AppShell() {
  const serverHealth = useServerHealth()
  return (
    <AppNavProvider>
      <ChatSessionsProvider>
        <DesktopWindowsProvider>
          <div className="flex min-h-0 flex-1 flex-col">
            <ServerStatusBanner health={serverHealth} />
            <ShellBody />
            <Toaster position="top-right" richColors closeButton />
          </div>
        </DesktopWindowsProvider>
      </ChatSessionsProvider>
    </AppNavProvider>
  )
}

function ShellBody() {
  const nav = useAppNavigation()
  if (nav?.route.kind === 'cabin') {
    return (
      <Suspense
        fallback={
          <div className="grid flex-1 place-items-center bg-pop-bg text-sm text-pop-dim">
            载入工作舱…
          </div>
        }
      >
        <CabinShellRoute />
      </Suspense>
    )
  }
  return <Desktop />
}
