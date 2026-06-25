"use client"

import { useState, useEffect } from "react"
import { FolderOpen, Workflow, Cpu } from "lucide-react"
import { fetchLeaderboard } from "@/lib/api-client"
import type { LeaderboardResponse } from "@/lib/types"
import { LeaderboardCard } from "./leaderboard-card"
import { WorkspaceRankingItem } from "./workspace-ranking-item"
import { WorkflowRankingItem } from "./workflow-ranking-item"
import { ModelRankingItem } from "./model-ranking-item"
import { Skeleton } from "@/components/ui/skeleton"

export function LeaderboardSection() {
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchLeaderboard()
        if (!cancelled) {
          setData(result)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载失败")
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <>
        <div role="status" aria-live="polite" className="sr-only">
          排行榜加载中...
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-[500px] w-full" />
          ))}
        </div>
      </>
    )
  }

  if (error) {
    return (
      <div className="grid gap-6 lg:grid-cols-3">
        {[1, 2, 3].map(i => (
          <LeaderboardCard key={i} title="排行榜" empty>
            <div />
          </LeaderboardCard>
        ))}
      </div>
    )
  }

  const isEmpty =
    !data ||
    (data.byWorkspace.length === 0 &&
      data.byWorkflow.length === 0 &&
      data.byModel.length === 0)

  return (
    <>
      <div role="status" aria-live="polite" className="sr-only">
        {isEmpty ? '暂无排行数据' : '排行榜加载完成'}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
      <LeaderboardCard
        title="Workspace 用量排行"
        icon={<FolderOpen className="h-4 w-4" />}
        empty={isEmpty || data!.byWorkspace.length === 0}
      >
        {data?.byWorkspace.map((item, i) => (
          <WorkspaceRankingItem key={item.workspaceId} rank={i + 1} item={item} />
        ))}
      </LeaderboardCard>

      <LeaderboardCard
        title="工作流用量排行"
        icon={<Workflow className="h-4 w-4" />}
        empty={isEmpty || data!.byWorkflow.length === 0}
      >
        {data?.byWorkflow.map((item, i) => (
          <WorkflowRankingItem
            key={`${item.executionId}-${item.workspaceId}`}
            rank={i + 1}
            item={item}
          />
        ))}
      </LeaderboardCard>

      <LeaderboardCard
        title="模型用量排行"
        icon={<Cpu className="h-4 w-4" />}
        empty={isEmpty || data!.byModel.length === 0}
      >
        {data?.byModel.map((item, i) => (
          <ModelRankingItem key={item.model} rank={i + 1} item={item} />
        ))}
      </LeaderboardCard>
    </div>
    </>
  )
}
