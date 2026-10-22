// Client component wrapping the global three-column shell.
"use client"

import { useState } from "react"
import { usePathname } from "next/navigation"
import { Header } from "@/components/layout/header"
import { AppRail } from "@/components/layout/app-rail"
import { WorkDock } from "@/components/layout/work-dock"
import { ConversationHome } from "@/components/agent/chat/ConversationHome"
import { Toaster } from "@/components/ui/sonner"

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const pathname = usePathname()
  const chatActive = pathname === "/"

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
          {/* 对话是应用级常驻视图：去别的页面只隐藏、不卸载，SSE/输入/滚动都保留。 */}
          <div className={chatActive ? "flex min-h-0 flex-1 flex-col" : "hidden"} aria-hidden={!chatActive}>
            <ConversationHome />
          </div>
          {!chatActive && (
            <div className="flex-1 overflow-y-auto">{children}</div>
          )}
        </main>
        <WorkDock />
      </div>
      <Toaster position="top-right" richColors closeButton />
    </div>
  )
}
