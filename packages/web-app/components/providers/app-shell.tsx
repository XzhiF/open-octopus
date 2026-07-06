// Client component wrapping Header.
"use client"

import { Header } from "@/components/layout/header"
import { AuthProvider } from "@/lib/auth-context"

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Header />
      <div className="flex-1">
        {children}
      </div>
    </AuthProvider>
  )
}
