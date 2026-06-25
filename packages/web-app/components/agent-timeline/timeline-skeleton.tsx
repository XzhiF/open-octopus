"use client"

import { Skeleton } from "@/components/ui/skeleton"

export function TimelineSkeleton() {
  return (
    <div className="space-y-3 p-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-[90%]" />
      <Skeleton className="h-8 w-[85%]" />
      <Skeleton className="h-8 w-[70%]" />
    </div>
  )
}
