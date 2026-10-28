'use client'

import { AppNavProvider } from '@/lib/app-navigation'
import { DesktopWindowsProvider } from '@/lib/desktop-windows'
import { Desktop } from '@/components/shell/desktop'
import { ServerStatusBanner } from '@/components/shell/server-status-banner'
import { Toaster } from '@/components/ui/sonner'
import { useServerHealth } from '@/hooks/use-server-health'
import { ChatSessionsProvider } from './chat-sessions'

/**
 * Desktop shell: the chat is the bottom layer, apps are floating windows,
 * and a single global header owns the app menu / window strip / Mission Control.
 */
export function AppShell() {
  const serverHealth = useServerHealth()
  return (
    <AppNavProvider>
      <ChatSessionsProvider>
        <DesktopWindowsProvider>
          <div className="flex min-h-0 flex-1 flex-col">
            <ServerStatusBanner health={serverHealth} />
            <Desktop />
            <Toaster position="top-right" richColors closeButton />
          </div>
        </DesktopWindowsProvider>
      </ChatSessionsProvider>
    </AppNavProvider>
  )
}
