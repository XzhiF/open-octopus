// Client component wrapping the global three-column shell.
"use client"

import { useState } from "react"
import { Header } from "@/components/layout/header"
import { AppRail } from "@/components/layout/app-rail"
import { WorkDock } from "@/components/layout/work-dock"
import { Toaster } from "@/components/ui/sonner"

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Header onOpenNav={() => setMobileNavOpen(true)} />
      <div className="flex flex-1 min-h-0">
        <AppRail
          mobileOpen={mobileNavOpen}
          onMobileOpenChange={setMobileNavOpen}
        />
        {/* 🎪 全站页面底:奶油纸 + 圆点彩纸 */}
        <main className="pop-confetti flex flex-1 flex-col min-h-0 overflow-y-auto">
          {children}
        </main>
        <WorkDock />
      </div>
      <Toaster position="top-right" richColors closeButton />
    </div>
  )
}
