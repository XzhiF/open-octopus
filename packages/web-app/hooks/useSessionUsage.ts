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
    void fetchSessionLLMCalls(sessionId)
      .then((a) => { if (!cancelled) setUsage(a.aggregates) })
      .catch(() => { if (!cancelled) setUsage(null) })
    return () => { cancelled = true }
  }, [sessionId, nonce])

  return usage
}
