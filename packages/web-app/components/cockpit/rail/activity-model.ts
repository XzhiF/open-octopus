// v22 十四轮（2026-11-21 用户）· 右栏「活动」的纯模型。
//
// 活动 = 汐音主会话里的两类后台工作：
//   · 子代理（作业坞「子代理」同一份数据：Agent 工具派生）
//   · 后台作业（provider 的 `background_tasks` 电平：run_in_background 的 Bash）
// 右栏「活动」浮层只取运行中（2026-11-24 用户 #2）；已结束的子代理 / 后台作业
// 留档由「更多 → 活动日志」消费（子代理 subagent_runs，后台作业 background_runs）。
//
// 出现条件 = 至少一条运行中（子代理或后台作业）。没有运行中的活动 → 右栏按钮照样常住，
// 点开是空态。

import type { BackgroundRunInfo, BackgroundTaskInfo, SubagentRunSummary } from '@/lib/agent/api'
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

/** 已结束的后台作业最多保留多少条（运行中的不截）。 */
export const BACKGROUND_ENDED_LIMIT = 20

export type ActivityItem =
  | { kind: 'subagent'; id: string; run: SubagentRunSummary }
  | {
      kind: 'background'
      id: string
      /** 运行中的电平信息，或结束留档派生的同形描述。 */
      task: BackgroundTaskInfo
      /** 服务端留档行：运行中也带（拿 started_at / output_file）。 */
      record?: BackgroundRunInfo
    }

export interface ActivityGroups {
  subagents: ActivityItem[]
  backgrounds: ActivityItem[]
  /** 运行中的子代理数。 */
  subLive: number
  /** 子代理总数（运行中 + 已结束留档）。 */
  subTotal: number
  /** 运行中的后台作业数。 */
  bgLive: number
  /** 后台作业总数（运行中 + 已结束留档）。 */
  bgTotal: number
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

/**
 * 后台化的子代理在 SDK 里有两份身份：subagent_runs（子代理）与 background_tasks
 * （`task_type: 'local_agent'`，同一个 task_id）。2026-11-25 用户：两边并排会
 * 重复显示同一次派工 —— 是子代理就只按子代理显示，后台作业不再重复列一遍。
 */
function isSubagentBackground(
  taskId: string,
  taskType: string | null | undefined,
  subagentIds: ReadonlySet<string>,
): boolean {
  return taskType === 'local_agent' || subagentIds.has(taskId)
}

export function activityItems(
  runs: readonly SubagentRunSummary[],
  backgrounds: readonly BackgroundTaskInfo[],
  records: readonly BackgroundRunInfo[] = [],
): ActivityItem[] {
  const subagentIds = new Set(runs.map((run) => run.id))
  const bgTasks = backgrounds.filter(
    (task) => !isSubagentBackground(task.id, task.taskType, subagentIds),
  )
  const byTask = new Map(records.map((row) => [row.task_id, row]))
  const live = bgTasks.map<ActivityItem>((task) => ({
    kind: 'background',
    id: `background:${task.id}`,
    task,
    ...(byTask.get(task.id) ? { record: byTask.get(task.id) } : {}),
  }))
  // 已结束留档：不在电平里的行（电平是权威的「还在跑」）。
  const liveIds = new Set(bgTasks.map((task) => task.id))
  const ended = records
    .filter((row) => !isSubagentBackground(row.task_id, row.task_type, subagentIds))
    .filter((row) => row.status !== 'running' && !liveIds.has(row.task_id))
    .sort((a, b) => endedAtOfRun(b) - endedAtOfRun(a))
    .slice(0, BACKGROUND_ENDED_LIMIT)
    .map<ActivityItem>((row) => ({
      kind: 'background',
      id: `background:${row.task_id}`,
      task: {
        id: row.task_id,
        description: row.description,
        ...(row.task_type ? { taskType: row.task_type } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}),
      },
      record: row,
    }))
  return [
    ...runs.map<ActivityItem>((run) => ({ kind: 'subagent', id: `subagent:${run.id}`, run })),
    ...live,
    ...ended,
  ]
}

function endedAtOfRun(row: BackgroundRunInfo): number {
  const at = row.ended_at ? Date.parse(row.ended_at) : NaN
  return Number.isFinite(at) ? at : Date.parse(row.started_at) || 0
}

export function activityIsLive(item: ActivityItem): boolean {
  if (item.kind === 'background') return item.record?.status !== 'stopped' && item.record?.status !== 'completed' && item.record?.status !== 'failed'
  return isSubagentLive(item.run)
}

/** 后台作业终态（中文标签）。 */
export function backgroundStatusLabel(status: BackgroundRunInfo['status'] | undefined): string {
  switch (status) {
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'stopped': return '已停止'
    default: return '运行中'
  }
}

export function activityTitle(item: ActivityItem): string {
  return item.kind === 'subagent' ? subagentTitle(item.run) : item.task.description
}

/** 列表第二行：类型 / 步数 / token，或后台任务类型。 */
export function activityMeta(item: ActivityItem, now?: number): string {
  if (item.kind === 'background') {
    const parts = [item.task.taskType ?? 'bash', 'run_in_background']
    if (item.record && !activityIsLive(item)) {
      const ms = endedAtOfRun(item.record) - (Date.parse(item.record.started_at) || 0)
      if (Number.isFinite(ms) && ms > 0) parts.push(formatStopwatch(ms))
    } else if (item.record && now != null) {
      const ms = now - (Date.parse(item.record.started_at) || now)
      if (Number.isFinite(ms) && ms > 0) parts.push(formatStopwatch(ms))
    }
    return parts.join(' · ')
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
  if (item.kind === 'background') {
    return activityIsLive(item) ? '运行中' : backgroundStatusLabel(item.record?.status)
  }
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
  let bgLive = 0
  for (const item of items) {
    if (item.kind === 'subagent') {
      subagents.push(item)
      if (isSubagentLive(item.run)) subLive += 1
    } else {
      backgrounds.push(item)
      if (activityIsLive(item)) bgLive += 1
    }
  }
  return {
    subagents,
    backgrounds,
    subLive,
    subTotal: subagents.length,
    bgLive,
    bgTotal: backgrounds.length,
    liveCount: subLive + bgLive,
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

export function backgroundRunsSignature(runs: readonly BackgroundRunInfo[]): string {
  return runs.map((row) => [
    row.task_id, row.status, row.description, row.ended_at ?? '', row.summary?.length ?? 0,
  ].join(':')).join('|')
}

/** 从启动命令 + 输出尾识别端口（原型「↗ 识别到的端口」）。 */
export function detectPorts(...texts: Array<string | null | undefined>): number[] {
  const out = new Set<number>()
  const push = (raw: string) => {
    const port = Number(raw)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) out.add(port)
  }
  const patterns = [
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::1):(\d{2,5})/gi,
    /https?:\/\/[^\s:/]+:(\d{2,5})/gi,
    /--port[= ](\d{2,5})/gi,
    /(?:^|\s)-p\s*(\d{2,5})(?:\s|$)/g,
    /\bPORT[=: ]\s*(\d{2,5})/gi,
    /listening on (?:port )?:?(\d{2,5})/gi,
    /:\s*(\d{4,5})\b/g,
  ]
  for (const text of texts) {
    if (!text) continue
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        push(match[1])
      }
    }
  }
  return [...out].sort((a, b) => a - b)
}
