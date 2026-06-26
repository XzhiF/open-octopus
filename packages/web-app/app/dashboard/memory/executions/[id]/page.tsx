"use client"

import { useParams } from "next/navigation"
import { ArchiveDetailPage } from "@/components/dashboard/archive-detail-page"

export default function ExecutionDetailRoute() {
  const params = useParams<{ id: string }>()
  return <ArchiveDetailPage executionId={params.id} />
}
