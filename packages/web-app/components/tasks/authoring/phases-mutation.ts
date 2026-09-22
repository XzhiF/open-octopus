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

/** 批次主 slug（2026-09-20 契约：Batch 目录 = `.scratch/<main>/<sub>/`）：
 *  任务级 `task_spec.slug` 优先；无此字段的存量任务（旧日期布局）从既有 phase 的
 *  specPath 反推父目录（跳过 8 位日期层）；都没有 → undefined。 */
export function mainSlugOf(task: Task): string | undefined {
  const spec = task.task_spec as unknown as { slug?: unknown; phases?: Array<{ specPath?: string }> }
  if (typeof spec.slug === "string" && SLUG_RE.test(spec.slug)) return spec.slug
  for (const p of spec.phases ?? []) {
    const m = (p.specPath ?? "").replace(/^\.\//, "").match(/^\.scratch\/([^/]+)\//)
    if (m && SLUG_RE.test(m[1]) && !/^\d{8}$/.test(m[1])) return m[1]
  }
  return undefined
}

/** 默认 specPath：新约定 `./.scratch/<main>/<sub>/spec.md`。main 缺失只可能发生在
 *  存量日期布局任务上手动建骨架 —— 回退旧日期约定与其同层共存（新草稿由
 *  task-author 定 spec.slug，不会走到这条回退）。 */
export function defaultSpecPath(slug: string, main?: string): string {
  if (main) return `./.scratch/${main}/${slug}/spec.md`
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
