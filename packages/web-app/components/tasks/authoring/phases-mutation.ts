// packages/web-app/components/tasks/authoring/phases-mutation.ts
//
// #53: phases[] 整数组写回的共享件（原 workflow-box.tsx 私有件外提）——
// PhaseListEditor 的结构操作与「草稿批次」区的 [建骨架并对位] 共用同一条
// S5 纪律：写回前 getTask 重取 version → fresh.phases 上 transform →
// renumber → 整数组 PUT + If-Match。禁第二份拷贝（漂移即断链）。

import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getTask, updateTask } from "@/lib/tasks-api"

export const DEFAULT_NEW_WORKFLOW = "built-in/matt-spec-dev"

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
export { SLUG_RE }

/** index = 数组位次 +1 重排（SKILL 契约「index=数组序」；仅 draft 期发生，
 *  ready 后结构编辑关闭，位次不再漂移）。 */
export function renumber(phases: TaskPhase[]): TaskPhase[] {
  return phases.map((p, i) => (p.index === i + 1 ? p : { ...p, index: i + 1 }))
}

/** 默认 specPath：home 相对批次约定 ./.scratch/<YYYYMMDD>/<slug>/spec.md */
export function defaultSpecPath(slug: string): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  return `./.scratch/${ymd}/${slug}/spec.md`
}

/** S5 写回样板：重取 fresh → 在 fresh.phases 上做 transform → 整数组 PUT +
 *  If-Match。fresh.phases 缺失（异常态）回退开窗快照。 */
export async function withPhases(
  task: Task,
  transform: (base: TaskPhase[]) => TaskPhase[],
): Promise<void> {
  const fresh = await getTask(task.id)
  const base = fresh.task_spec.phases ?? task.task_spec.phases ?? []
  const next = renumber(transform(base))
  await updateTask(
    task.id,
    { task_spec: { ...fresh.task_spec, phases: next } as TaskSpec },
    fresh.version,
  )
}
