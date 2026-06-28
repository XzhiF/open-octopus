"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { MemoryTab } from "@/components/dashboard/memory-tab"
import DashboardPage from "../page"

function DashboardTabContent() {
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab")

  if (tab === "memory") {
    return (
      <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">工作流编排平台概览</p>
        </div>
        <div>
          <h2 className="text-xl font-semibold mb-4">执行记忆</h2>
          <MemoryTab />
        </div>
      </div>
    )
  }

  // Default: show main dashboard (redirect to /)
  return <DashboardPage />
}

export default function DashboardPageRoute() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto flex items-center justify-center px-4 py-12 lg:px-6">
          <p className="text-muted-foreground">加载中...</p>
        </div>
      }
    >
      <DashboardTabContent />
    </Suspense>
  )
}
