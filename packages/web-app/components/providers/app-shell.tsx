'use client'

import { AppNavProvider } from '@/lib/app-navigation'
import { DesktopWindowsProvider } from '@/lib/desktop-windows'
import { Desktop } from '@/components/shell/desktop'
import { Toaster } from '@/components/ui/sonner'
import { ChatSessionsProvider } from './chat-sessions'

/**
 * Desktop shell: the chat is the bottom layer, apps are floating windows,
 * and a single global header owns the app menu / window strip / Mission Control.
 */
export function AppShell() {
  return (
    <AppNavProvider>
      <ChatSessionsProvider>
        <DesktopWindowsProvider>
          <div className="flex min-h-0 flex-1 flex-col">
            <Desktop />
            <Toaster position="top-right" richColors closeButton />
          </div>
        </DesktopWindowsProvider>
      </ChatSessionsProvider>
    </AppNavProvider>
  )
}
