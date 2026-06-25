"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { FragilityScore } from "@/lib/analytics-types"

interface FragilityRankingProps {
  data: FragilityScore[]
}

export function FragilityRanking({ data }: FragilityRankingProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">节点脆弱度排行</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">暂无失败数据</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">节点脆弱度排行</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {data.map((item, idx) => (
          <div key={`${item.workflowRef}-${item.nodeId}`} className="flex items-center gap-3">
            <span className="text-xs font-mono text-muted-foreground w-6">#{idx + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-medium text-sm truncate">{item.nodeId}</span>
                <Badge variant="outline" className="text-xs">{item.nodeType}</Badge>
                <span className="text-xs text-muted-foreground">{item.failures}/{item.totalRuns}</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-destructive rounded-full transition-all"
                  style={{ width: `${Math.min(item.fragilityScore, 100)}%` }}
                />
              </div>
            </div>
            <span className="text-sm font-semibold tabular-nums">{item.fragilityScore}%</span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
