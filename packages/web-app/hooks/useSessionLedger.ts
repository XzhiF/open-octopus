'use client'

// 会话账本取数（v49；2026-10-29 起同时供 turn 统计用）。
// 刷新时机 = 轮次收尾沿（streaming true→false）：llm_calls 是 result chunk 到达即落账，
// 轮次中途的数字没有意义；也不轮询 —— 它和 ctx% 一样本来就是轮次粒度的量。
//
// `calls` 是逐 call 行：composer 的 token 角标只用 aggregates，chat 的
// turn 统计（计时 / token / 缓存）用 calls 按消息归属。

import { useEffect, useRef, useState } from 'react'
import { fetchSessionLLMCalls } from '@/lib/observability-api'
import type { LlmUsageAggregates } from '@octopus/shared'
import type { LLMCallData } from '@/lib/types'

export interface SessionLedger {
  aggregates: LlmUsageAggregates | null
  calls: LLMCallData[]
}

export function useSessionLedger(
  sessionId: string | null | undefined,
  streaming = false,
): SessionLedger {
  const [aggregates, setAggregates] = useState<LlmUsageAggregates | null>(null)
  const [calls, setCalls] = useState<LLMCallData[]>([])
  const [nonce, setNonce] = useState(0)
  const wasStreaming = useRef(false)

  useEffect(() => {
    if (wasStreaming.current && !streaming) setNonce((n) => n + 1)
    wasStreaming.current = streaming
  }, [streaming])

  useEffect(() => {
    if (!sessionId) {
      setAggregates(null)
      setCalls([])
      return
    }
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    // 空账 / 取数失败补拉一次：会话刚创建时拉到的空账、轮次刚收尾的可见性
    // 窗口、或短暂网络错误，都会让 chip 停在 tok --；一次补拉足以覆盖。
    const load = (attempt: number) => {
      void fetchSessionLLMCalls(sessionId)
        .then((a) => {
          if (cancelled) return
          setAggregates(a.aggregates)
          setCalls(Array.isArray(a.data) ? a.data : [])
          if (a.aggregates.totalCalls === 0 && attempt === 0) {
            retryTimer = setTimeout(() => load(1), 1000)
          }
        })
        .catch(() => {
          if (cancelled) return
          setAggregates(null)
          setCalls([])
          if (attempt === 0) retryTimer = setTimeout(() => load(1), 1500)
        })
    }
    load(0)
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [sessionId, nonce])

  return { aggregates, calls }
}
