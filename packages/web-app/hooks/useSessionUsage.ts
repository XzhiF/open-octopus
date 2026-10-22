'use client'

// 会话账本取数（v49）—— 聊天角标的数据源。
// 刷新时机 = 轮次收尾沿（streaming true→false）：llm_calls 是 result chunk 到达即落账，
// 轮次中途的数字没有意义；也不轮询 —— 它和 ctx% 一样本来就是轮次粒度的量。

import { useEffect, useRef, useState } from 'react'
import { fetchSessionLLMCalls } from '@/lib/observability-api'
import type { LlmUsageAggregates } from '@octopus/shared'

export function useSessionUsage(
  sessionId: string | null | undefined,
  streaming = false,
): LlmUsageAggregates | null {
  const [usage, setUsage] = useState<LlmUsageAggregates | null>(null)
  const [nonce, setNonce] = useState(0)
  const wasStreaming = useRef(false)

  useEffect(() => {
    if (wasStreaming.current && !streaming) setNonce((n) => n + 1)
    wasStreaming.current = streaming
  }, [streaming])

  useEffect(() => {
    if (!sessionId) {
      setUsage(null)
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
          setUsage(a.aggregates)
          if (a.aggregates.totalCalls === 0 && attempt === 0) {
            retryTimer = setTimeout(() => load(1), 1000)
          }
        })
        .catch(() => {
          if (cancelled) return
          setUsage(null)
          if (attempt === 0) retryTimer = setTimeout(() => load(1), 1500)
        })
    }
    load(0)
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [sessionId, nonce])

  return usage
}
