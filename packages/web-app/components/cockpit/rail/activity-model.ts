// v22 十四轮（2026-11-21 用户）· 右栏「活动」的纯模型。
//
// 活动 = 汐音主会话里**正在跑**的两类后台工作：
//   · 子代理（作业坞「子代理」同一份数据：Agent 工具派生）
//   · 后台作业（provider 的 `background_tasks` 电平：run_in_background 的 Bash）
// 口径与原型一致：运行中置顶；子代理额外保留最近几条已结束的，方便回看；
// 后台作业服务端只存运行中电平（结束即出队），所以只有 live。
//
// 出现条件 = 至少一条运行中（子代理或后台作业）。没有运行中的活动 → 右栏不出按钮。

import type { BackgroundTaskInfo, SubagentRunSummary } from '@/lib/agent/api'
import {
  isSubagentLive,
  subagentElapsedMs,
  subagentStatusLabel,
  subagentTitle,
  subagentTokenTotal,
} from '@/lib/subagent-format'
import { formatStopwatch, formatTokenCount } from '@/lib/format'

/** 已结束的子代理最多保留多少条（运行中的不截）。 */
export const ACTIVITY_ENDED_LIMIT = 12

export type ActivityItem =
  | { kind: 'subagent'; id: string; run: SubagentRunSummary }
  | { kind: 'background'; id: string; task: BackgroundTaskInfo }

export interface ActivityGroups {
  subagents: ActivityItem[]
  backgrounds: ActivityItem[]
  /** 运行中的子代理数。 */
  subLive: number
  /** 子代理总数（运行中 + 已结束留档）。 */
  subTotal: number
  /** 后台作业数（服务端只给运行中）。 */
  bgLive: number
  /** 按钮徽标 = 运行中总数。 */
  liveCount: number
}

function startedAtOf(run: SubagentRunSummary): number {
  const at = Date.parse(run.started_at)
  return Number.isFinite(at) ? at : 0
}

function endedAtOf(run: SubagentRunSummary): number {
  const at = run.ended_at ? Date.parse(run.ended_at) : NaN
  return Number.isFinite(at) ? at : startedAtOf(run)
}

/** 运行中在前（先起的在前），已结束按结束时间倒序，只留最近 N 条。 */
export function trimSubagentRuns(
  runs: readonly SubagentRunSummary[],
  endedLimit = ACTIVITY_ENDED_LIMIT,
): SubagentRunSummary[] {
  const live = runs.filter(isSubagentLive).sort((a, b) => startedAtOf(a) - startedAtOf(b))
  const done = runs
    .filter((run) => !isSubagentLive(run))
    .sort((a, b) => endedAtOf(b) - endedAtOf(a))
    .slice(0, endedLimit)
  return [...live, ...done]
}

export function activityRawId(item: ActivityItem): string {
  return item.kind === 'subagent' ? item.run.id : item.task.id
}

export function activityItems(
  runs: readonly SubagentRunSummary[],
  backgrounds: readonly BackgroundTaskInfo[],
): ActivityItem[] {
  return [
    ...runs.map<ActivityItem>((run) => ({ kind: 'subagent', id: `subagent:${run.id}`, run })),
    ...backgrounds.map<ActivityItem>((task) => ({ kind: 'background', id: `background:${task.id}`, task })),
  ]
}

export function activityIsLive(item: ActivityItem): boolean {
  // 后台作业来自 `background_tasks` 电平：拿到的就是正在跑的。
  return item.kind === 'background' ? true : isSubagentLive(item.run)
}

export function activityTitle(item: ActivityItem): string {
  return item.kind === 'subagent' ? subagentTitle(item.run) : item.task.description
}

/** 列表第二行：类型 / 步数 / token，或后台任务类型。 */
export function activityMeta(item: ActivityItem): string {
  if (item.kind === 'background') {
    return [item.task.taskType ?? 'bash', 'run_in_background'].join(' · ')
  }
  const tokens = subagentTokenTotal(item.run)
  return [
    item.run.agent_type ?? 'subagent',
    item.run.step_count > 0 ? `${item.run.step_count} 步` : null,
    tokens > 0 ? `${formatTokenCount(tokens)} tok` : null,
  ].filter(Boolean).join(' · ')
}

/** 列表右列：运行中走计时，已结束显示终态。 */
export function activityRightLabel(item: ActivityItem, now: number): string {
  if (item.kind === 'background') return '运行中'
  const run = item.run
  if (!isSubagentLive(run)) return subagentStatusLabel(run.status)
  const elapsed = subagentElapsedMs(run, now)
  return elapsed != null ? `运行 · ${formatStopwatch(elapsed)}` : '运行中'
}

/** 分两组 + 计数：与原型 `.ip-group` 的标题读数同口径。 */
export function groupActivity(items: readonly ActivityItem[]): ActivityGroups {
  const subagents: ActivityItem[] = []
  const backgrounds: ActivityItem[] = []
  let subLive = 0
  for (const item of items) {
    if (item.kind === 'subagent') {
      subagents.push(item)
      if (isSubagentLive(item.run)) subLive += 1
    } else {
      backgrounds.push(item)
    }
  }
  return {
    subagents,
    backgrounds,
    subLive,
    subTotal: subagents.length,
    bgLive: backgrounds.length,
    liveCount: subLive + backgrounds.length,
  }
}

/** 轮询签名：内容没变就不换数组，避免每 4s 抖一次右栏。 */
export function subagentRunsSignature(runs: readonly SubagentRunSummary[]): string {
  return runs.map((run) => [
    run.id,
    run.status,
    run.step_count,
    run.input_tokens,
    run.output_tokens,
    run.cache_read_tokens,
    run.cache_creation_tokens,
    run.summary?.length ?? 0,
    run.ended_at ?? '',
  ].join(':')).join('|')
}

export function backgroundTasksSignature(tasks: readonly BackgroundTaskInfo[]): string {
  return tasks.map((task) => `${task.id}:${task.description}:${task.taskType ?? ''}`).join('|')
}
