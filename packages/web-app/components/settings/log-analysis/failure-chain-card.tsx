"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ArrowRight, XCircle, SkipForward } from "lucide-react"
import type { FailureChain } from "@/lib/analytics-types"

interface FailureChainCardProps {
  data: FailureChain[]
}

export function FailureChainCard({ data }: FailureChainCardProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">失败链分析</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">暂无失败链数据</p></CardContent>
      </Card>
    )
  }

  // Group by failedNode, take top downstream per failed node
  const grouped = new Map<string, FailureChain>()
  for (const chain of data) {
    const existing = grouped.get(chain.failedNode)
    if (!existing || chain.occurrences > existing.occurrences) {
      grouped.set(chain.failedNode, chain)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">失败链分析</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {Array.from(grouped.values()).map((chain) => {
          const isDownstreamFailed = chain.downstreamStatus === "failed"
          return (
            <div key={`${chain.failedNode}-${chain.downstreamNode}`} className="flex items-center gap-2 text-sm p-2 rounded-md bg-muted/50">
              <span className="font-medium">{chain.failedNode}</span>
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="font-medium">{chain.downstreamNode}</span>
              {isDownstreamFailed ? (
                <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              ) : (
                <SkipForward className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <span className="text-xs text-muted-foreground ml-auto">
                {chain.occurrences} 次 · {chain.downstreamStatus}
              </span>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
