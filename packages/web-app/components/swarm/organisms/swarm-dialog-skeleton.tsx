"use client"

import { Skeleton } from "@/components/ui/skeleton"

export function SwarmDialogSkeleton() {
  return (
    <div className="space-y-4">
      {/* Header skeleton */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>

      {/* Metric cards skeleton */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>

      {/* Tab bar skeleton */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-8 w-20 rounded-md" />
        ))}
      </div>

      {/* Content area skeleton */}
      <div className="space-y-3">
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    </div>
  )
}
