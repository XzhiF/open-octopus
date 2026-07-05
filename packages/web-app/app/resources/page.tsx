"use client"

import { Suspense } from "react"
import { ResourcePage } from "@/components/resources/resource-page"

export default function ResourcesListPage() {
  return (
    <Suspense fallback={<div className="container mx-auto px-4 py-6 lg:px-6"><div className="animate-pulse space-y-4"><div className="h-8 w-48 rounded bg-muted" /><div className="h-10 w-full rounded bg-muted" /><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{Array.from({length:6}).map((_,i)=><div key={i} className="h-48 rounded-xl bg-muted" />)}</div></div></div>}>
      <ResourcePage />
    </Suspense>
  )
}
