// Client component wrapping Header.
"use client"

import { Header } from "@/components/layout/header"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <div className="flex-1">
        {children}
      </div>
    </>
  )
}
