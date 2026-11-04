'use client'

import { useEffect, useState } from 'react'
import { listRunningExecutions, type RunningExecution } from '@/lib/agent/api'

const POLL_MS = 2_000

/**
 * 运行中的工作流执行（header 右上角「运行中」指示）。
 *
 * chat 的生成流走 useRunningAgents；工作流 Agent 节点不在 chat 流里，只能靠
 * executions 表的顶层 running 行。失败保留上一份快照，避免一次抖动清空指示。
 */
export function useRunningExecutions(): RunningExecution[] {
  const [runs, setRuns] = useState<RunningExecution[]>([])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const { runs: items } = await listRunningExecutions()
        if (!cancelled) setRuns(Array.isArray(items) ? items : [])
      } catch {
        /* server unavailable — keep the previous snapshot */
      }
    }

    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    const onVisibility = () => {
      if (!document.hidden) void load()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return runs
}
