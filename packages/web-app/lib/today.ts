import { apiFetch, handleResponse } from "./api-client"
import { getServerUrl } from "./server-config"

/**
 * 「今日」页 wire 形状（服务端 services/today-digest.ts 是唯一真相源）。
 * 时间线 / 变动都是**精选**结果，页面不再做二次筛选；类目数量来自服务端。
 */

export type TodayChangeCat = "task" | "agent" | "clone" | "know"
export type TodayTimelineKind = "chat" | "task" | "agent" | "clone" | "know" | "now"

export interface TodayCost {
  usd: number | null
  complete: boolean
}

export interface TodayChangeItem {
  ts: string
  cat: TodayChangeCat
  title: string
  meta?: string
}

export interface TodayTimelineNode {
  ts: string
  kind: TodayTimelineKind
  title: string
  detail?: string
  meta?: string
  tone?: "ok" | "warn" | "bad" | "info"
}

export interface TodayDigest {
  generated_at: string
  date: string
  weekday: string
  window: { since: string }
  consumption: {
    tokens: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    calls: number
    cost: TodayCost
    cache_hit_rate: number | null
    cache_saved: TodayCost
    split: Array<{ bucket: "chat" | "task" | "system"; tokens: number; share: number }>
  }
  stats: {
    tasks: {
      changed: number
      breakdown: Array<{ key: string; label: string; count: number }>
    }
    chats: { sessions: number; converted: number; running: number }
    clones: {
      total: number
      changed: number
      version: number
      skill: number
      memory: number
      file: number
    }
    knowledge: { added: number; updated: number; compiles: number; available: boolean }
  }
  timeline: { nodes: TodayTimelineNode[]; candidates: number; rule: string }
  changes: { items: TodayChangeItem[]; total: number }
  now: { count: number; pending: string[] }
}

export async function fetchTodayDigest(): Promise<TodayDigest> {
  const res = await apiFetch(`${getServerUrl()}/api/dashboard/today`)
  return handleResponse<TodayDigest>(res)
}

/** 类目固定顺序与标签（筛选按钮与时间线标签共用）。 */
export const CHANGE_CAT_LABEL: Record<TodayChangeCat, string> = {
  task: "任务",
  agent: "AGENT",
  clone: "分身",
  know: "知识库",
}

export const TIMELINE_KIND_LABEL: Record<TodayTimelineKind, string> = {
  chat: "对话",
  task: "任务",
  agent: "AGENT",
  clone: "分身",
  know: "知识库",
  now: "现在",
}