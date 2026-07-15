// Client component wrapping Header.
"use client"

import { Header } from "@/components/layout/header"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Header />
      <main className="flex flex-1 flex-col min-h-0">
        {children}
      </main>
    </div>
  )
}
