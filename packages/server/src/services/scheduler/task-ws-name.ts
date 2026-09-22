// packages/server/src/services/scheduler/task-ws-name.ts
//
// 任务启动时的 workspace 命名 (2026-08-29 起；2026-09-20 英文名收口)。
//
// 禁中文命名纪律：workspace name 会直接成为磁盘目录名
// (`~/.octopus/orgs/{org}/workspaces/{name}`)、config.json 与 git 分支名 ——
// 非 ASCII 目录是 Node v24 cpSync 无声猝死 (0xC0000409) 的事故土壤，且冒号
// (`task:` 前缀) 曾让 Windows mkdir 全线 ENOENT。因此本函数产出的**整串**
// 匹配 shared 的 WORKSPACE_NAME_PATTERN (/^[a-zA-Z0-9_-]+$/)，展示名 == 目录名，
// 双轨 sanitize 不复存在。
//
// 取名优先级：
//   1. 标题（task.name 优先；默认名走 chatbot 同款 spec.goal 截取，见
//      taskDisplayTitle）剥成 ASCII core —— 部分中文（"token计费"）保住英文段；
//   2. 标题全非 ASCII → task_spec.slug（批次主 slug，2026-09-20 契约），缺则
//      v4 phases[0].slug（两者都已过 path-safe schema 校验）；
//   3. 连 slug 都没有 → `t{djb2-hash}` 稳定短哈希（复合子单元中文名在同秒下仍可区分）；
//   4. 标题本身取不到（无 name 且无 goal）→ 返回 null，调用方 (ws-launch.ts)
//      保留 `taskpool-{id}-{suffix}` 兜底。
//
// task-phase-redesign（票 05，K12）：v4 任务一 task 一 ws —— 本函数只在**首建**
// 路径被调用（tasks.workspace_id 为空时 execute() 才取名建 ws），后续 phase/round
// 复用既有 ws、不再拼名；同名目录现为显式报错（旧 rmSync 覆写已移除）。
// `-MMDD-HHmmss` 尾缀保留 —— 其职责是"不同任务/不同首建时刻互不撞名"。
//
// git 分支前缀（taskBranchPrefix，2026-09-22 收口）：`taskpool-{taskId-uuid}` 太
// 逆天 —— 现为 spec.branch 显式（author 起草定名）> `feat-<slug|标题锚>-<YYYYMMDD>`
// （created_at 派生，两侧逐字节确定）> taskpool-{taskId} 兜底（K5 一 task 一信封
// ⇒ 恒定，phase/round 不换支）。

import { DEFAULT_TASK_NAME } from "../tasks/tasks-service"

/** chatbot 会话智能标题同款截断。 */
const TITLE_MAX = 20

/** ASCII core 长度上限（goal 前 20 字英文可近 20 字符，留连字符余量）。 */
const CORE_MAX = 40

/** 任务展示标题：用户改过名 → 用名；默认名 → goal 前 20 字；都没有 → ""。 */
export function taskDisplayTitle(row: { name: string | null; task_spec: string | null | unknown }): string {
  const name = (row.name ?? "").trim()
  if (name && name !== DEFAULT_TASK_NAME) return name
  try {
    const spec = typeof row.task_spec === "string" ? JSON.parse(row.task_spec) : (row.task_spec ?? {})
    const goal = (spec as { goal?: unknown }).goal
    if (typeof goal === "string") return goal.slice(0, TITLE_MAX).replace(/\n/g, " ").trim()
  } catch { /* 坏 JSON → 无标题，调用方回退旧命名 */ }
  return ""
}

/** task_spec 的英文命名锚，两级：task 级主 slug（2026-09-20 批次契约，
 *  `.scratch/<slug>/<sub>/` 的父目录名）优先 —— 它就是这条流水线的 feature
 *  名；缺则退回 v4 phases[0].slug。两者都已过 path-safe schema 校验。 */
export function specSlugAnchor(row: { task_spec: string | null | unknown }): string {
  try {
    const spec = typeof row.task_spec === "string" ? JSON.parse(row.task_spec) : (row.task_spec ?? {})
    const s = spec as { slug?: unknown; phases?: unknown }
    if (typeof s.slug === "string" && s.slug) return s.slug
    if (Array.isArray(s.phases)) {
      const slug = (s.phases[0] as { slug?: unknown } | undefined)?.slug
      if (typeof slug === "string") return slug
    }
  } catch { /* 坏 JSON / 形状不对 → 无锚，走下一优先级 */ }
  return ""
}

/** 剥出合法 ASCII core：空白→'-'、非 [A-Za-z0-9_-]（含中文）整段剔除、
 *  连字符折叠去边、截断 CORE_MAX。可能返回 ""（标题全非 ASCII）。 */
function asciiSlug(raw: string): string {
  return raw
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CORE_MAX)
    .replace(/-+$/g, "")
}

/** djb2 → 6 位 base36。确定性哈希 —— trigger 预建与 executor 两侧对同一行
 *  必须产出逐字节一致的名字（ws-launch.ts 的存在理由），不可掺随机。 */
function asciiHash(raw: string): string {
  let h = 5381
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0
  return h.toString(36).padStart(6, "0").slice(0, 6)
}

/** 执行 git 分支前缀（taskBranchPrefix）。取名优先级：
 *    1. spec.branch —— author 起草时的显式定名（唯一「由 agent 确定」通道）；
 *       过 asciiSlug 兜住手改坏值（中文/冒号/空格一律剔除）。
 *    2. `feat-<slug锚>-<YYYYMMDD>` —— slug 锚 = spec.slug ∪ phases[0].slug
 *       （path-safe 已过 schema）；日期取 task 创建日（确定性，两侧逐字节一致）。
 *    3. 连锚都取不到 → null，调用方保留 `taskpool-{taskId}` 兜底。
 *  与旧 `taskpool-{id}` 一样：一 task 一支系（K5 恒定，phase/round 不换支），
 *  且整串匹配 ^[a-zA-Z0-9_-]+$（git 分支 + worktree 目录双约束）。 */
export function taskBranchPrefix(
  row: { task_spec: string | null | unknown; created_at?: string | null },
): string | null {
  let branch = ""
  try {
    const spec = (typeof row.task_spec === "string" ? JSON.parse(row.task_spec) : (row.task_spec ?? {})) as {
      branch?: unknown
    }
    if (typeof spec.branch === "string") branch = spec.branch
  } catch { /* 坏 JSON → 无显式名，走 slug 推导 */ }
  const explicit = asciiSlug(branch)
  if (explicit) return explicit

  const anchor = asciiSlug(specSlugAnchor(row))
  if (!anchor) return null
  const d = row.created_at ? new Date(row.created_at) : new Date()
  const stamp = Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  return `feat-${anchor}${stamp ? `-${stamp}` : ""}`
}

/** `task-{core}-{MMDD-HHmmss}`，core 按文件头注释的四级取名。
 *  返回 null 表示无从取名（无 name 且无 goal），调用方保留 taskpool-{id} 兜底。 */
export function taskWorkspaceName(
  row: { name: string | null; task_spec: string | null | unknown },
  opts?: { subName?: string; date?: Date },
): string | null {
  const title = taskDisplayTitle(row)
  if (!title) return null
  const d = opts?.date ?? new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const ts = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const joined = opts?.subName ? `${title} ${opts.subName}` : title
  const core =
    asciiSlug(joined) ||
    asciiSlug(specSlugAnchor(row)) ||
    `t${asciiHash(joined)}`
  return `task-${core}-${ts}`
}
