// Client component wrapping the global three-column shell.
"use client"

import { useState } from "react"
import { Header } from "@/components/layout/header"
import { AppRail } from "@/components/layout/app-rail"
import { WorkDock } from "@/components/layout/work-dock"
import { ConversationHome } from "@/components/agent/chat/ConversationHome"
import { ViewHost } from "@/components/shell/view-host"
import { DetailTabsProvider } from "@/lib/detail-tabs"
import { DetailTabBar } from "@/components/shell/detail-tab-bar"
import { DetailTabsHost } from "@/components/shell/detail-tabs-host"
import { StandaloneHost } from "@/components/shell/standalone-host"
import { NotFoundView } from "@/components/shell/not-found-view"
import { AppNavProvider, useAppNavigation } from "@/lib/app-navigation"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"

export function AppShell() {
  return (
    <AppNavProvider>
      <ShellInner />
    </AppNavProvider>
  )
}

function ShellInner() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const nav = useAppNavigation()
  if (!nav) throw new Error("ShellInner must be rendered inside AppNavProvider")

  const activeView = nav.mode === "view" ? nav.view : null
  const chatVisible = activeView === "chat"
  const viewHostActive = activeView && activeView !== "chat" ? activeView : null
  const detailVisible = nav.mode === "detail"
  const standalone = nav.mode === "standalone" && nav.route.kind === "standalone" ? nav.route : null

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Header onOpenNav={() => setMobileNavOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <AppRail
          mobileOpen={mobileNavOpen}
          onMobileOpenChange={setMobileNavOpen}
        />
        {/* 🎪 全站页面底:奶油纸 + 圆点彩纸 */}
        <main className="pop-confetti relative flex flex-1 flex-col min-h-0 overflow-hidden">
          <DetailTabsProvider>
            <DetailTabBar />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* 对话应用级常驻：任何视图切换/详情路由都只隐藏不卸载，SSE 不断。 */}
              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col",
                  chatVisible ? "" : "hidden",
                )}
                aria-hidden={!chatVisible}
                inert={!chatVisible}
              >
                <ConversationHome />
              </div>

              {/* 顶层视图宿主：懒挂载一次后常驻，切视图保留状态。 */}
              <ViewHost activeView={viewHostActive} />

              {/* 详情标签宿主：全部标签常驻，仅活动标签可见。 */}
              <DetailTabsHost />

              {standalone && <StandaloneHost route={standalone} />}

              {nav.mode === "not-found" && (
                <div className="absolute inset-0 overflow-y-auto">
                  <NotFoundView />
                </div>
              )}

              {nav.mode === "redirect" && (
                <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-pop-dim">
                  跳转中…
                </div>
              )}

              {detailVisible && nav.tabKey === null && (
                <div className="absolute inset-0 flex items-center justify-center font-mono text-[11px] text-pop-dim">
                  加载详情…
                </div>
              )}
            </div>
          </DetailTabsProvider>
        </main>
        <WorkDock />
      </div>
      <Toaster position="top-right" richColors closeButton />
    </div>
  )
}
