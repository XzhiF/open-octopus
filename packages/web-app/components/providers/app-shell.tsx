// Client component wrapping the global three-column shell.
"use client"

import { useState } from "react"
import { Header } from "@/components/layout/header"
import { AppRail } from "@/components/layout/app-rail"
import { WorkDock } from "@/components/layout/work-dock"
import { ConversationHome } from "@/components/agent/chat/ConversationHome"
import { ViewHost } from "@/components/shell/view-host"
import { AppNavProvider, useAppNavigation } from "@/lib/app-navigation"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppNavProvider>
      <ShellInner>{children}</ShellInner>
    </AppNavProvider>
  )
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const nav = useAppNavigation()
  const mode = nav?.mode ?? 'view'
  const view = nav?.view ?? 'chat'

  const chatVisible = mode === 'view' && view === 'chat'
  const viewHostActive = mode === 'view' && view !== 'chat' ? view : null
  const detailVisible = mode === 'detail'

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Header onOpenNav={() => setMobileNavOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <AppRail
          mobileOpen={mobileNavOpen}
          onMobileOpenChange={setMobileNavOpen}
        />
        {/* 🎪 全站页面底:奶油纸 + 圆点彩纸 */}
        <main className="pop-confetti flex flex-1 flex-col min-h-0 overflow-hidden">
          {/* 对话应用级常驻：任何视图切换/详情路由都只隐藏不卸载，SSE 不断。 */}
          <div
            className={cn("flex min-h-0 flex-1 flex-col", chatVisible ? "" : "hidden")}
            aria-hidden={!chatVisible}
          >
            <ConversationHome />
          </div>

          {/* 顶层视图宿主：懒挂载一次后常驻，切视图保留状态。 */}
          <ViewHost activeView={viewHostActive} />

          {/* 详情路由继续交给 Next 渲染；对话与视图宿主保持挂载。 */}
          {detailVisible && (
            <div className="flex-1 overflow-y-auto">{children}</div>
          )}
        </main>
        <WorkDock />
      </div>
      <Toaster position="top-right" richColors closeButton />
    </div>
  )
}