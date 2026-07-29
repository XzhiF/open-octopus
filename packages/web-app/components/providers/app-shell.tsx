// Client component wrapping Header.
"use client"

import { Header } from "@/components/layout/header"
import { Toaster } from "@/components/ui/sonner"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Header />
      <main className="flex flex-1 flex-col min-h-0 overflow-y-auto">
        {children}
      </main>
      <Toaster position="top-right" richColors closeButton />
    </div>
  )
}
