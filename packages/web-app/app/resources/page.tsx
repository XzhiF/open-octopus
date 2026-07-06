"use client"

import { useSearchParams } from "next/navigation"
import { ResourceList } from "@/components/resource/resource-list"
import { AuditLog } from "@/components/resource/audit-log"
import { TrustManager } from "@/components/resource/trust-manager"
import { Suspense } from "react"

export default function ResourcesPage() {
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab") || "list"

  return (
    <Suspense>
      {tab === "audit" ? (
        <AuditLog />
      ) : tab === "trust" ? (
        <TrustManager />
      ) : (
        <ResourceList />
      )}
    </Suspense>
  )
}
