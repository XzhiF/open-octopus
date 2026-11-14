// S2 owns this file.
//
// taskPct —— 逐字搬自 CabinFleet.tsx:28-42（S9 让 CabinFleet 改 import 本模块，
// S3 用它画 task 行进度条）。只对 task 行使用；workflow/subagent 不画进度条
// （plans §1.5，旧实现里的假 45% 在 S9 删除）。
//
// 行为必须与搬出前完全一致（含 task 缺失时返回 0），单测钉住。

import { taskDisplayStatus, type CabinTaskRow } from '@/components/cabin/modules/ui'
import type { TaskPhaseView } from '@/lib/tasks-api'

/** v4 phaseViews → 真实进度百分比；没有 phase 视图返回 null（不猜）。 */
export function pctFromPhases(phases: readonly TaskPhaseView[]): number | null {
  if (phases.length === 0) return null
  const accepted = phases.filter((p) => p.status === 'accepted').length
  const current = phases.find((p) => p.status !== 'accepted')
  if (!current) return 100
  const rounds = current.rounds?.length ?? 0
  const doneRounds = Math.max(0, (current.currentRound ?? 1) - 1)
  const frac = rounds > 0 ? Math.min(1, doneRounds / rounds) : 0
  return Math.round(((accepted + frac) / phases.length) * 100)
}

export function taskPct(task: CabinTaskRow | undefined): number {
  if (!task) return 0
  const pct = pctFromPhases(task.derived?.phaseViews ?? [])
  if (pct !== null) return pct
  const s = taskDisplayStatus(task)
  return s === 'done' ? 100 : s === 'running' ? 50 : 0
}
