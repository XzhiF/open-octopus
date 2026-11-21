// 右栏「更多 → 日志」的数据模型（v22 十五轮 · 2026-11-21 用户）。
//
// 口径 = 主会话里**我发出的 prompt**（复用 lib/agent/user-turns 的真人发言判定），
// 一条 prompt 一根时间线节点；节点上的摘要行照抄主对话 TUI 的 meta：
//   状态（已完成 / 已中断 / 进行中）· 耗时 · 步数 · 工具 · 思考 · token · 费用。
//
// 统计只认服务端账本：assistant 行先由 buildTurnStats(messages, calls) 挂上
// turnStats，本模型再把同一轮里多条 assistant 的统计相加。没有账本行 → 不编
// 耗时 / token（显示为空），不拿首字延迟等客户端数字冒充。
//
// 纯函数（无 React / 无 IO），供面板与测试共用。

import type { AgentMessage } from '@/lib/agent/types'
import type { TurnStats } from '@/lib/turn-stats'
import { proxyTurnOf } from '@/lib/agent/display-content'

export type LogTurnStatus = 'done' | 'interrupted' | 'pending'

export interface LogTurn {
  /** prompt 消息 id（也是 DOM key / 测试锚点）。 */
  id: string
  prompt: string
  /** prompt 的 created_at（ISO）；排序与分组都用它。 */
  at: string
  status: LogTurnStatus
  steps: number
  tools: number
  thinks: number
  /** 0 = 账本没有耗时。 */
  durationMs: number
  tokens: number
  /** null = 整轮都没配价；costComplete=false = 已知部分和。 */
  costUsd: number | null
  costComplete: boolean
  /** 本轮账本里有没有统计行（决定摘要行是否显示耗时 / token / 费用）。 */
  hasStats: boolean
}

export interface LogTotals {
  count: number
  tokens: number
  longestMs: number
  /** null = 没有任何可计价轮。 */
  costUsd: number | null
  costComplete: boolean
}

/** 真人 prompt：与 user-turns 同一判据（排除事件卡 / 角色切换 / 代理转达 / 空正文）。 */
export function isHumanPrompt(message: AgentMessage): boolean {
  return message.role === 'user'
    && message.displayType !== 'event'
    && !message.roleSwitch
    && !proxyTurnOf(message.content)
    && message.content.trim().length > 0
}

/** 一轮的过程条目数 —— 与 TuiTranscript.TuiMeta 的 rows 口径一致：
 *  timeline 里 thinking / 命中的 tool / text 各算一步；无 timeline 时用字段兜底。 */
function processCounts(message: AgentMessage): { steps: number; tools: number; thinks: number } {
  const toolList = Array.isArray(message.tool_calls) ? message.tool_calls : []
  let steps = 0
  let tools = 0
  let thinks = 0
  if (Array.isArray(message.timeline) && message.timeline.length > 0) {
    for (const entry of message.timeline) {
      if (entry.kind === 'thinking' && entry.text) {
        steps++
        thinks++
      } else if (entry.kind === 'tool') {
        // TuiMeta 只认能对上 tool_calls 的条目（孤立的 timeline 行不渲染）。
        if (toolList.some((tool) => tool.id === entry.id)) {
          steps++
          tools++
        }
      } else if (entry.kind === 'text' && entry.text) {
        steps++
      }
    }
    return { steps, tools, thinks }
  }
  if (message.thinking) {
    steps++
    thinks++
  }
  for (const _tool of toolList) {
    steps++
    tools++
  }
  return { steps, tools, thinks }
}

function addStats(turn: Omit<LogTurn, 'id' | 'prompt' | 'at'>, assistant: AgentMessage): void {
  const stats: TurnStats | undefined = assistant.turnStats
  if (!stats) return
  turn.hasStats = true
  turn.tokens += stats.tokens
  if (stats.durationMs != null && stats.durationMs > 0) turn.durationMs += stats.durationMs
  if (typeof stats.costUsd === 'number') {
    turn.costUsd = (turn.costUsd ?? 0) + stats.costUsd
  } else {
    turn.costComplete = false
  }
  if (!stats.costComplete) turn.costComplete = false
}

/**
 * prompt 消息 → 日志时间线（原序，最新在最后；面板自行 reverse）。
 * assistant 行按「下一条真人 prompt」切轮，事件卡 / 角色切换 / 工具行不参与。
 */
export function buildLogTurns(messages: readonly AgentMessage[]): LogTurn[] {
  const turns: Array<LogTurn & { assistants: AgentMessage[] }> = []
  let current: (LogTurn & { assistants: AgentMessage[] }) | null = null

  for (const message of messages) {
    // 真人 prompt 之外，任何 user 行（代转达 / 角色切换 / 空正文）都按账本
    // 同口径切轮：它后面的 assistant 不是对我的 prompt 的回复，不并入上一轮。
    // 事件卡例外（它是某一轮中途落库的卡，不是新发言）。
    if (message.role === 'user' && message.displayType !== 'event') {
      if (isHumanPrompt(message)) {
        current = {
          id: message.id,
          prompt: message.content.trim(),
          at: message.created_at,
          status: 'pending',
          steps: 0,
          tools: 0,
          thinks: 0,
          durationMs: 0,
          tokens: 0,
          costUsd: null,
          costComplete: true,
          hasStats: false,
          assistants: [],
        }
        turns.push(current)
      } else {
        current = null
      }
      continue
    }
    if (!current || message.role !== 'assistant') continue
    if (message.displayType === 'event' || message.roleSwitch) continue
    current.assistants.push(message)
  }

  return turns.map(({ assistants, ...turn }) => {
    const counts = { steps: 0, tools: 0, thinks: 0 }
    for (const assistant of assistants) {
      const part = processCounts(assistant)
      counts.steps += part.steps
      counts.tools += part.tools
      counts.thinks += part.thinks
      addStats(turn, assistant)
    }
    if (assistants.length > 0) {
      turn.status = assistants.some((assistant) => assistant.interrupted)
        ? 'interrupted'
        : assistants.some((assistant) => assistant.streaming)
          ? 'pending'
          : 'done'
    }
    turn.steps = counts.steps
    turn.tools = counts.tools
    turn.thinks = counts.thinks
    return turn
  })
}

/** 顶部统计条：指令数 / 总 token / 最长单轮耗时 / 总费用。 */
export function logTotals(turns: readonly LogTurn[]): LogTotals {
  let tokens = 0
  let longestMs = 0
  let costUsd: number | null = null
  let costComplete = true
  for (const turn of turns) {
    tokens += turn.tokens
    if (turn.durationMs > longestMs) longestMs = turn.durationMs
    if (!turn.hasStats) continue
    if (turn.costUsd == null) costComplete = false
    else costUsd = (costUsd ?? 0) + turn.costUsd
    if (!turn.costComplete) costComplete = false
  }
  return { count: turns.length, tokens, longestMs, costUsd, costComplete }
}

/** 关键词过滤（大小写不敏感，只搜 prompt 原文）。空查询 = 全量。 */
export function filterLogTurns(turns: readonly LogTurn[], query: string): LogTurn[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...turns]
  return turns.filter((turn) => turn.prompt.toLowerCase().includes(needle))
}
