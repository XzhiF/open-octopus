"use client"

import type { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface LeaderboardCardProps {
  title: string
  icon?: ReactNode
  children: ReactNode
  className?: string
  empty?: boolean
}

export function LeaderboardCard({
  title,
  icon,
  children,
  className,
  empty = false,
}: LeaderboardCardProps) {
  return (
    <Card role="region" aria-label={title} className={cn("h-full py-3 gap-2", className)}>
      <CardHeader className="pb-1 pt-1 px-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto max-h-[400px] pt-0 px-3" role="list" aria-label={`${title}列表`}>
        {empty ? (
          <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
            <p className="text-sm">暂无用量数据</p>
            <p className="text-xs mt-1">执行工作流后将显示排行榜</p>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}
