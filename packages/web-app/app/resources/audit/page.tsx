"use client"

import { Suspense } from "react"
import { AuditPage } from "@/components/resources/audit-page"

export default function ResourcesAuditPage() {
  return (
    <Suspense fallback={<div className="container mx-auto px-4 py-6 lg:px-6"><div className="animate-pulse space-y-4"><div className="h-8 w-48 rounded bg-muted" /><div className="h-10 w-full rounded bg-muted" /><div className="space-y-2">{Array.from({length:5}).map((_,i)=><div key={i} className="h-12 w-full rounded bg-muted" />)}</div></div></div>}>
      <AuditPage />
    </Suspense>
  )
}
