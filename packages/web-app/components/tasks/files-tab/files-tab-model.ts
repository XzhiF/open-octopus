// packages/web-app/components/tasks/files-tab/files-tab-model.ts
//
// 票 03「≡ 变更」页签的纯逻辑单源：统计同源、刷新节流、比例条、分组显示序。
//
// 期望口径来自 spec.md 故事 6/8/9 与原型 taskboard-v2.html（fitem dbar / 每 5s
// 同步指示 / 统计条六格），数据契约 = 既有 RoundDiffPayload（server S3 形状，
// 票03 起执行中轮也供货 —— 见 server round-evidence-service.resolveRoundForDiff）。
// 本模块不碰 DOM、不 fetch —— FilesTab/useRoundDiffFeed 是唯一消费者；
// 票 09 的台账预览复用 scopeTotals，保证「统计条 = 台账数字」同源。

import type { RoundDiffPayload } from "@/lib/tasks-api"

/** 「≡ 变更」执行中兜底轮询周期：spec 口径滞后 ≤10s，留事件触发余量。 */
export const FILES_POLL_MS = 9000
/** SSE 事件（task_execution/artifacts/verify 等）触发刷新的最小间隔 —— 防节点
 *  事件风暴把 diff 端点打穿；被拒的事件走 trailing 补拉（不丢新鲜度）。 */
export const FILES_EVENT_MIN_GAP_MS = 1500

export interface DiffStats {
  commits: number
  files: number
  additions: number
  dels: number
  /** harness 干预次数；null = 无账目（UI 出「—」，与 0 是两回事）。 */
  interventions: number | null
}

const EMPTY_STATS: DiffStats = { commits: 0, files: 0, additions: 0, dels: 0, interventions: null }

/** 统计条与列表同源规则（票 09 契约）：只统计**在场渲染**的仓 —— expired 仓
 *  在面板里单列琥珀警示、不进数字。与 server aggregate 的口径一致但独立实现，
 *  前端换 scope 载荷时统计条不可能和列表说两家话。 */
export function scopeTotals(diff: RoundDiffPayload | null): DiffStats {
  if (!diff) return EMPTY_STATS
  const base: DiffStats = { ...EMPTY_STATS, interventions: diff.interventions }
  return diff.repos.filter((r) => !r.expired).reduce<DiffStats>(
    (a, r) => ({
      commits: a.commits + r.commits,
      files: a.files + r.files,
      additions: a.additions + r.additions,
      dels: a.dels + r.dels,
      interventions: a.interventions,
    }),
    base,
  )
}

/** 节流判定：距上次完成是否已够 minGap；lastAt=null（首次）恒放行。 */
export function throttleDue(now: number, lastAt: number | null, minGapMs: number): boolean {
  return lastAt === null || now - lastAt >= minGapMs
}

/** 被节流拒掉的事件刷新 → 补足到 minGap 的 trailing 延迟。 */
export function throttleWaitMs(now: number, lastAt: number, minGapMs: number): number {
  return Math.max(0, minGapMs - (now - lastAt))
}

/** 壳的哪些状态值得拉 diff（服务端口径：awaiting 轮 ∨ live 轮；其余 409 面上无货）。 */
export function canServeRoundDiff(status: string): boolean {
  return status === "running" || status === "paused" || status === "awaiting_review"
}

/** 文件行绿红比例条：adds 占比（0~1）；零变更兜底全绿（原型 dbar 的 pct 口径）。 */
export function addRatio(adds: number, dels: number): number {
  const t = adds + dels
  return t === 0 ? 1 : adds / t
}

/** 目录组显示序：churn(±) 降序，同 churn 按 dir 字典序 —— server 排 churn 不排
 *  平手，轮询刷新时平手组会跳位；客户端定死，两轮渲染序一致。不改入参。 */
export function sortRepoGroups<T extends { dir: string; additions: number; dels: number }>(groups: T[]): T[] {
  return [...groups].sort((a, b) =>
    b.additions + b.dels - (a.additions + a.dels) || a.dir.localeCompare(b.dir),
  )
}

// ── 票07「查看 diff」跳链定位 ───────────────────────────────────────────
// 对话页签工具卡带的是 task-doer 工作区路径（绝对、Windows 反斜杠），变更行是
// 仓相对 posix —— 后缀匹配（完整路径段边界），精确相等自然赢，歧义取最具体行。

export interface RevealTarget { repo: string; path: string }

function pathSegHit(rel: string, want: string): boolean {
  return rel === want || rel.endsWith(`/${want}`) || want.endsWith(`/${rel}`)
}

export function matchReveal(diff: RoundDiffPayload | null, wantRaw: string): RevealTarget | null {
  if (!diff) return null
  const want = wantRaw.replace(/\\/g, "/").toLowerCase()
  let best: RevealTarget | null = null
  for (const repo of diff.repos) {
    if (repo.expired) continue
    for (const g of repo.groups) {
      for (const f of g.files) {
        const rel = f.path.replace(/\\/g, "/").toLowerCase()
        if (!pathSegHit(rel, want)) continue
        if (!best || rel.length > best.path.length) best = { repo: repo.name, path: f.path }
      }
    }
  }
  return best
}
