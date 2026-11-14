'use client'

import { Suspense } from 'react'
import { AppNavProvider, useAppNavigation } from '@/lib/app-navigation'
import { DesktopWindowsProvider } from '@/lib/desktop-windows'
import { CABIN_COMPONENTS } from '@/lib/route-components'
import { CabinModeProvider } from '@/components/cabin/cabin-mode'
import { Desktop } from '@/components/shell/desktop'
import { ServerStatusBanner } from '@/components/shell/server-status-banner'
import { Toaster } from '@/components/ui/sonner'
import { useServerHealth } from '@/hooks/use-server-health'
import { ChatSessionsProvider } from './chat-sessions'

/**
 * Desktop shell: the chat is the bottom layer, apps are floating windows,
 * and a single global header owns the app menu / window strip / Mission Control.
 *
 * 作战舱（Cabin）有两种入口：
 *   · 桌面内：CabinModeProvider 管 activeCabinId/drafting，ConversationHome 在
 *     同一壳内切对话上下文（不改路由，见 2026-11-13 原型对齐）。
 *   · 深链 /cabin/:cabinId：兄弟壳 CabinShell，共享同一 provider 栈。
 */
export function AppShell() {
  const serverHealth = useServerHealth()
  return (
    <AppNavProvider>
      <ChatSessionsProvider>
        <DesktopWindowsProvider>
          <CabinModeProvider>
            <div className="flex min-h-0 flex-1 flex-col">
              <ServerStatusBanner health={serverHealth} />
              <ShellBody />
              <Toaster position="top-right" richColors closeButton />
            </div>
          </CabinModeProvider>
        </DesktopWindowsProvider>
      </ChatSessionsProvider>
    </AppNavProvider>
  )
}

function ShellBody() {
  const nav = useAppNavigation()
  if (nav?.route.kind === 'cabin') {
    // 兄弟壳按 componentKey 分发：/cabin/:cabinId → cabin-shell，
    // /cabin/:cabinId/cockpit → cabin-cockpit。两条都是整屏壳，不挂桌面。
    const CabinComponent =
      CABIN_COMPONENTS[nav.route.componentKey] ?? CABIN_COMPONENTS['cabin-shell']
    return (
      <Suspense
        fallback={
          <div className="grid flex-1 place-items-center bg-pop-bg text-sm text-pop-dim">
            {nav.route.componentKey === 'cabin-cockpit' ? '载入全域座舱…' : '载入作战舱…'}
          </div>
        }
      >
        <CabinComponent />
      </Suspense>
    )
  }
  return <Desktop />
}
