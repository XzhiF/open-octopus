'use client'

// 会话账本聚合（v49）—— 聊天角标的数据源。
// 取数逻辑已下沉到 useSessionLedger（turn 统计共用同一次请求）；
// 这里保留窄返回类型，既有调用方（ChatArea / CloneDetailView）无需改动。

import type { LlmUsageAggregates } from '@octopus/shared'
import { useSessionLedger } from './useSessionLedger'

export function useSessionUsage(
  sessionId: string | null | undefined,
  streaming = false,
): LlmUsageAggregates | null {
  return useSessionLedger(sessionId, streaming).aggregates
}
