// packages/server/src/services/tasks/repo-sync-service.ts
//
// 项目镜像同步状态机（draft repo-sync 2026-09-08，特性 A 的核）。
//
// 用户不变量：repos 主 clone 永远干净且停在 main/master —— 它们是**一次性
// 镜像**（本地改动全丢弃已获授权），任务的 agent 分析读的就是这些路径
// （context.md → resolveRepoPath = 主 clone），所以创建 draft 携带项目后
// 必须立刻把它们对齐到 origin 最新，task-author chat 开工前也要确认同步
// 完成（waitUntilIdle + context.md 新鲜度行）。
//
// 设计纪律：
// - **进程内、无 DB** —— 快照是易失提示，不是事实源（事实源 = git 本身；
//   server 重启后 hasSnapshot=false，chat 门会自动补触发，见 routes/clone）。
// - per-repo in-flight 去重：repoKey = `org::绝对路径`，两个任务勾同一仓库
//   只跑一次 fetch/reset，完成后各自拿各自的 SSE。
// - 全链 fire-and-forget：syncProjectsForTask 不同步 await 任何 git；内部
//   每个 promise 自带 catch，绝不让 git 失败冒回 createTask 的 HTTP 响应。
// - 未注入 = 特性关闭（TasksService 第 7 参、clone routes deps 尾参均可选），
//   既有 22 个测试构造零改动。

import { PROJECT_SYNC_EVENT } from "@octopus/shared"
import { gitOps } from "../git-ops"
import { WorkspaceGit } from "../workspace-git"

export type ProjectSyncStatus = "syncing" | "ok" | "failed"

export interface ProjectSyncSnapshot {
  project: string
  status: ProjectSyncStatus
  /** 同步到的默认分支（ok 时）。 */
  branch?: string
  /** HEAD 短 8 位（ok 时）。 */
  commit?: string
  /** 失败原因（failed 时；直接进 context.md 行与 toast）。 */
  error?: string
  syncedAt: string
}

export interface RepoSyncDeps {
  /** SSEService 结构化最小面（emit(channel, {event,data})）。 */
  sse?: { emit(channel: string, event: { event: string; data: unknown }): void }
  /** 单仓镜像同步实现（默认 gitOps.syncToDefaultBranch；测试注入 stub）。 */
  sync?: (repoPath: string) => Promise<{ branch: string; commit: string }>
  /** org+项目名 → 主 clone 绝对路径；解析失败 throw（默认 WorkspaceGit）。 */
  resolve?: (org: string, name: string) => string
}

interface InflightRepo {
  promise: Promise<void>
  /** 等这次同步完成的任务 → 其项目显示名（完成后逐任务写各自快照 + 各发一条
   *  SSE；跨 org 同仓异名时不能用首个名字兜底全部 watcher）。 */
  watchers: Map<string, string>
}

export class RepoSyncService {
  private readonly sse?: RepoSyncDeps["sse"]
  private readonly sync: (repoPath: string) => Promise<{ branch: string; commit: string }>
  private readonly resolve: (org: string, name: string) => string

  /** repoKey → 在途/排队中的同步（完成后立即删除条目）。 */
  private readonly inflight = new Map<string, InflightRepo>()
  /** taskId → projectName → 最新快照（chat 门与 context.md 的读取面）。 */
  private readonly snapshots = new Map<string, Map<string, ProjectSyncSnapshot>>()

  constructor(deps: RepoSyncDeps = {}) {
    this.sse = deps.sse
    this.sync = deps.sync ?? ((p) => gitOps.syncToDefaultBranch(p))
    const git = new WorkspaceGit()
    this.resolve = deps.resolve ?? ((org, name) => git.resolveRepoPath(org, name))
  }

  // ── 写路径 ────────────────────────────────────────────────────────

  /**
   * 对任务的选中项目发起镜像同步。fire-and-forget：本函数同步返回，
   * git 在后台跑；调用方（createTask / spec 写路径 / chat 门补触发）绝不
   * 被 git 失败拖住。同 (task, project) 已 syncing 时幂等并入在途同步。
   */
  syncProjectsForTask(taskId: string, org: string | undefined, names: string[]): void {
    const o = org ?? ""
    for (const name of names) {
      this.syncOne(taskId, o, name)
    }
  }

  private syncOne(taskId: string, org: string, name: string): void {
    let repoPath: string
    try {
      repoPath = this.resolve(org, name)
    } catch (e: unknown) {
      this.record(taskId, name, {
        project: name,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        syncedAt: new Date().toISOString(),
      })
      return
    }

    const repoKey = `${org}::${repoPath}`
    const existing = this.inflight.get(repoKey)
    if (existing) {
      existing.watchers.set(taskId, name)
      this.record(taskId, name, { project: name, status: "syncing", syncedAt: new Date().toISOString() })
      return
    }

    const entry: InflightRepo = { promise: Promise.resolve(), watchers: new Map([[taskId, name]]) }
    this.record(taskId, name, { project: name, status: "syncing", syncedAt: new Date().toISOString() })
    entry.promise = this.runSync(repoKey, repoPath, entry).finally(() => {
      this.inflight.delete(repoKey)
    })
    this.inflight.set(repoKey, entry)
  }

  private async runSync(repoKey: string, repoPath: string, entry: InflightRepo): Promise<void> {
    try {
      const { branch, commit } = await this.sync(repoPath)
      for (const [taskId, project] of entry.watchers) {
        this.record(taskId, project, {
          project, status: "ok", branch, commit, syncedAt: new Date().toISOString(),
        })
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`[RepoSync] mirror sync failed for ${repoKey}: ${message}`)
      for (const [taskId, project] of entry.watchers) {
        this.record(taskId, project, {
          project, status: "failed", error: message, syncedAt: new Date().toISOString(),
        })
      }
    }
  }

  private record(taskId: string, project: string, snap: ProjectSyncSnapshot): void {
    let byName = this.snapshots.get(taskId)
    if (!byName) {
      byName = new Map()
      this.snapshots.set(taskId, byName)
    }
    byName.set(project, snap)
    this.sse?.emit("taskpool", {
      event: PROJECT_SYNC_EVENT,
      data: {
        task_id: taskId, project, status: snap.status,
        branch: snap.branch, commit: snap.commit, error: snap.error, at: snap.syncedAt,
      },
    })
  }

  /** 任务终结（abort）时回收映射，防 task→repo 快照泄漏（内存量级=历史任务数）。 */
  forget(taskId: string): void {
    this.snapshots.delete(taskId)
    for (const entry of this.inflight.values()) entry.watchers.delete(taskId)
  }

  // ── 读路径 ────────────────────────────────────────────────────────

  /** 该任务是否已有任何同步记录（server 重启后为 false → chat 门补触发）。 */
  hasSnapshot(taskId: string): boolean {
    const byName = this.snapshots.get(taskId)
    return !!byName && byName.size > 0
  }

  /** 该任务是否仍有项目在途同步。 */
  isBusy(taskId: string): boolean {
    const byName = this.snapshots.get(taskId)
    if (!byName) return false
    for (const snap of byName.values()) {
      if (snap.status === "syncing") return true
    }
    return false
  }

  /**
   * 有界等待任务的全部项目脱离 syncing（chat 门 / trigger 预建共用的汇合点）。
   * 750ms 轮询；超时**放行不抛** —— 门是建议性的（agent 从 context.md 的
   * ⚠ 行自行判断），绝不让一次慢 fetch 卡死对话或触发。
   */
  async waitUntilIdle(taskId: string, timeoutMs = 45_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.isBusy(taskId) && Date.now() < deadline) {
      await sleep(750)
    }
  }

  /**
   * context.md 的「仓库新鲜度」标注（per-project）：ok=✓ 行 / failed=⚠ 原因 /
   * 仍在途=⚠ 超时。无快照 → undefined（不注，等同未同步口径）。
   */
  freshnessNotes(taskId: string, names: string[]): Record<string, string> | undefined {
    const byName = this.snapshots.get(taskId)
    if (!byName) return undefined
    let notes: Record<string, string> | undefined
    for (const name of names) {
      const line = this.freshnessLine(taskId, name)
      if (line) (notes ??= {})[name] = line
    }
    return notes
  }

  freshnessLine(taskId: string, project: string): string | undefined {
    const snap = this.snapshots.get(taskId)?.get(project)
    if (!snap) return undefined
    switch (snap.status) {
      case "ok":
        return `[${snap.branch} @${snap.commit} · 已同步 ✓]`
      case "failed":
        return `⚠ 同步失败: ${snap.error}（代码可能过期）`
      case "syncing":
        return `⚠ 同步未完成，代码可能过期`
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    // 轮询 timer 不阻止进程退出（测试/优雅关闭）。
    t.unref?.()
  })
}
