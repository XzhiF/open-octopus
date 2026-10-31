// 新建任务起手用哪个 org —— 单一解析点。
//
// 背景（bug 2026-10-27）：对话式新建任务（看板 [+新建任务] / 侧栏「新任务」）
// 只把 `useOrgs()` 的第一项当 org 用，而 orgs 由服务端按 name 升序返回
// （miyuan < xzf < xzf-dev），于是任务被静默绑到 miyuan：项目清单只列
// miyuan 的仓库，org=xzf 的仓库根本选不到（绑定项目弹窗也没有 org 开关）。
// 排序不是用户意图 —— 记住用户上次选的 org，其次跟随最近的任务，最后才回退。

export const TASK_ORG_STORAGE_KEY = 'octopus.tasks.org.v1'

export interface ResolveTaskOrgInput {
  /** Registered org names (any order). */
  orgs: string[]
  /** Last org the user explicitly chose for a task, if any. */
  remembered?: string | null
  /** Org names of recent tasks, newest first. */
  recentTaskOrgs?: (string | null | undefined)[]
}

/** Pick the org a new task should start in:
 *  remembered choice → newest task's org → first registered org. */
export function resolveTaskOrg({ orgs, remembered, recentTaskOrgs }: ResolveTaskOrgInput): string {
  if (orgs.length === 0) return 'default'
  if (remembered && orgs.includes(remembered)) return remembered
  for (const org of recentTaskOrgs ?? []) {
    if (org && orgs.includes(org)) return org
  }
  return orgs[0]
}

export function readRememberedTaskOrg(): string | null {
  try {
    return window.localStorage.getItem(TASK_ORG_STORAGE_KEY)
  } catch {
    return null
  }
}

export function rememberTaskOrg(org: string): void {
  try {
    window.localStorage.setItem(TASK_ORG_STORAGE_KEY, org)
  } catch {
    /* storage unavailable (private mode / quota) — the org still applies to
       the task being created; only the cross-session memory is lost. */
  }
}
