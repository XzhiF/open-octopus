"use client"

import { useSearchParams } from "next/navigation"
import { ResourceList } from "@/components/resource/resource-list"
import { AuditLog } from "@/components/resource/audit-log"
import { SourceList } from "@/components/resource/source-list"
import { SourceInstallTab } from "@/components/resource/source-install-tab"
import { Suspense } from "react"

export default function ResourcesPage() {
  const searchParams = useSearchParams()
  const tab = searchParams.get("tab") || "list"

  return (
    <Suspense>
      {tab === "install" ? (
        <SourceInstallTab />
      ) : tab === "audit" ? (
        <AuditLog />
      ) : tab === "sources" ? (
        <SourceList />
      ) : (
        <ResourceList />
      )}
    </Suspense>
  )
}
