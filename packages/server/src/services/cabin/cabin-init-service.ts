// packages/server/src/services/cabin/cabin-init-service.ts
//
// CabinInitService — the one genuinely new orchestration in Cabin P1: an
// agent-driven setup gate modeled on InitService.initAgent idempotence +
// archiving per-item resume. Gates 1–6 are deterministic service calls (no
// LLM); gate 7 (first-task proposal) is a real orchestrator turn through
// the normal chat endpoint (self-POST, same path ChatEventBridge.wake uses).
//
// Truth on disk: .cabin/init-state.json (per-item resume) + .cabin/manifest.json
// (identity, hash-stamped). cabins.init_state is only a cold-load mirror.
// Progress streams on SSE channel `cabin:<id>`; milestone cards land in the
// cabin main transcript via ChatEventBridge (zero LLM).

import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"
import type { CabinInitState } from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type { CabinRow } from "../../db/types"
import type { SSEService } from "../sse"
import { WorkspaceGit } from "../workspace-git"
import { gitOps } from "../git-ops"
import { getChatEventBridge } from "../activity/chat-event-bridge"
import {
  ensureRepoCloned, readCabinConfig, mergeCabinRepoEntry, repoSource, resolveCabinRepo,
  readLocalRepoInfo, isGitRepo, projectKey, type CabinRepoEntry,
} from "./cabin-repos"
import { nameForRequirements, UNNAMED_CABIN_NAME } from "./cabin-naming"

export interface CabinInitDeps {
  cabin: CabinDAO
  sse: SSEService
  workspaceGit?: WorkspaceGit
  /** Injectable for tests; production default self-POSTs the chat endpoint. */
  runOrchestratorTurn?: (sessionId: string, message: string, org: string | null) => Promise<void>
}

interface GateDef {
  key: string
  label: string
  fixHint: string
  deepLink: string
}

const GATE_DEFS: GateDef[] = [
  { key: "dir", label: "目录可写", fixHint: "检查目录路径与写权限", deepLink: "settings" },
  { key: "git", label: "git 可用", fixHint: "安装 git 或修正 PATH", deepLink: "settings" },
  { key: "clone", label: "克隆 ORG 仓库", fixHint: "检查 org 仓库注册表与 git 认证", deepLink: "repos" },
  { key: "mainline", label: "项目 / 主线登记", fixHint: "登记 main_path / 主线分支；worktree 按作业开", deepLink: "repos" },
  { key: "skeleton", label: "舱骨架 .cabin/", fixHint: "检查目录写权限", deepLink: "settings" },
  { key: "requirements", label: "需求落盘", fixHint: "检查目录写权限", deepLink: "settings" },
  { key: "first-plan", label: "首批任务建议", fixHint: "检查模型服务配置后重试门禁", deepLink: "settings" },
]

const now = () => new Date().toISOString()

/** True only when every defined gate item is present and done — a partial
 *  snapshot (older gate set / interrupted run) never counts as complete. */
export function isInitComplete(state: CabinInitState): boolean {
  return GATE_DEFS.every((def) => state.items.some((i) => i.key === def.key && i.state === "done"))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Production gate-7 runner: a real agent turn through the normal chat
 *  endpoint (same auth headers as ChatEventBridge.wake). Consumes the SSE
 *  stream to completion; an `error` event fails the gate honestly. */
async function defaultOrchestratorTurn(sessionId: string, message: string, org: string | null): Promise<void> {
  const port = process.env.PORT ?? "3001"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 600_000)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer agent",
        "X-Octopus-Org": org ?? "",
      },
      body: JSON.stringify({ message, wake: true }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`chat endpoint returned ${res.status}`)
    const reader = res.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ""
    let currentEvent = ""
    let sawError: string | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim()
        else if (line.startsWith("data:") && currentEvent === "error") {
          sawError = line.slice(5).trim()
        }
      }
    }
    if (sawError) throw new Error(`orchestrator turn failed: ${sawError}`)
  } finally {
    clearTimeout(timer)
  }
}

export class CabinInitService {
  private readonly git: WorkspaceGit
  private readonly running = new Set<string>()

  constructor(private deps: CabinInitDeps) {
    this.git = deps.workspaceGit ?? new WorkspaceGit()
  }

  /** Disk truth (.cabin/init-state.json), falling back to the DB cold-load
   *  mirror, then a fresh 7-item gate. Always merged against GATE_DEFS so an
   *  older snapshot gains newly added items as pending. */
  loadState(row: CabinRow): CabinInitState {
    let items: CabinInitState["items"] = []
    const diskPath = path.join(row.path, ".cabin", "init-state.json")
    try {
      const parsed = JSON.parse(fs.readFileSync(diskPath, "utf-8")) as CabinInitState
      if (Array.isArray(parsed.items)) items = parsed.items
    } catch {
      if (row.init_state) {
        try {
          const parsed = JSON.parse(row.init_state) as CabinInitState
          if (Array.isArray(parsed.items)) items = parsed.items
        } catch { /* corrupt mirror → fresh gate */ }
      }
    }
    const byKey = new Map(items.map((i) => [i.key, i]))
    return {
      items: GATE_DEFS.map((def) => {
        const existing = byKey.get(def.key)
        return existing ?? { key: def.key, label: def.label, state: "pending" as const }
      }),
    }
  }

  /** Idempotent gate run: skips done items, resumes at the first non-done.
   *  Stops at the first failure (later gates depend on earlier ones); retry
   *  re-enters here. Concurrent calls for the same cabin are no-ops. */
  async runGate(cabinId: string): Promise<void> {
    const row = this.deps.cabin.findById(cabinId)
    if (!row) throw new Error(`cabin not found: ${cabinId}`)
    if (row.status !== "initializing") {
      throw new Error(`cabin ${cabinId} is not initializing (status=${row.status})`)
    }
    if (this.running.has(cabinId)) return
    this.running.add(cabinId)
    try {
      // v5：舱名可选。空名建出来的舱先叫「未命名舱」，初始化开头按需求取名 ——
      // 放在门禁之前，所以 gate 7 的提示语已经是真名；取名变化经 init 进度事件
      // 触发前端重取（useCabin 的 cabin_init_progress 订阅）。
      this.ensureName(row)
      const state = this.loadState(row)
      this.card(row, state, "running")
      this.emitProgress(cabinId, state)
      for (const item of state.items) {
        if (item.state === "done") continue
        item.state = "running"
        this.persist(row, state)
        this.emitProgress(cabinId, state)
        try {
          await this.runItem(row, item)
          item.state = "done"
          delete item.error
        } catch (err) {
          const def = GATE_DEFS.find((d) => d.key === item.key)
          item.state = "failed"
          item.error = errMsg(err)
          item.fix_hint = def?.fixHint
          item.deep_link = def?.deepLink
          this.persist(row, state)
          this.emitProgress(cabinId, state)
          this.card(row, state, "failed")
          return
        }
        this.persist(row, state)
        this.emitProgress(cabinId, state)
      }
      this.deps.cabin.updateStatus(cabinId, "active", now())
      this.deps.sse.emit(`cabin:${cabinId}`, {
        event: "cabin_status",
        data: { cabin_id: cabinId, status: "active" },
      })
      this.card(row, state, "done")
    } finally {
      this.running.delete(cabinId)
    }
  }

  /** 没填舱名的舱（v5）：初始化开头按需求取一个，写回 cabins.name。
   *  乐观锁冲突（别处刚改过名）时不覆盖，直接读最新的那一行。 */
  private ensureName(row: CabinRow): void {
    const current = (row.name ?? "").trim()
    if (current !== "" && current !== UNNAMED_CABIN_NAME) return
    const next = nameForRequirements(row.requirements)
    const ok = this.deps.cabin.updateFields(row.id, row.version, { name: next }, now())
    if (!ok) {
      const fresh = this.deps.cabin.findById(row.id)
      if (fresh) row.name = fresh.name
      return
    }
    row.name = next
    row.version += 1
  }

  // ── gate items ─────────────────────────────────────────────────────

  private async runItem(row: CabinRow, item: CabinInitState["items"][number]): Promise<void> {
    switch (item.key) {
      case "dir": {
        fs.mkdirSync(row.path, { recursive: true })
        const probe = path.join(row.path, ".cabin-write-probe")
        fs.writeFileSync(probe, "ok", "utf-8")
        fs.rmSync(probe, { force: true })
        return
      }
      case "git": {
        const r = spawnSync("git", ["--version"], { timeout: 10_000 })
        if (r.status !== 0) throw new Error("git 命令未找到或不可用")
        item.sub = (r.stdout ?? "").toString().trim()
        return
      }
      case "clone": {
        // 跨 org（v4 I5）：config.json.repos[] 的 group 就是该仓库的 org；
        // 老数据 group 为空时回落到舱级 row.org。
        // 本地 / 外部项目**不克隆**：只校验目录存在且是 git repo。
        const repoEntries = readCabinConfig(row.path).repos.filter((r) => r.name)
        if (repoEntries.length === 0) { item.sub = "无仓库"; return }
        const failed: string[] = []
        let orgCloned = 0
        let localMapped = 0
        for (const entry of repoEntries) {
          if (repoSource(entry) === "local") {
            const { mainPath } = resolveCabinRepo(row.path, entry)
            if (!mainPath || !isGitRepo(mainPath)) {
              failed.push(`${entry.name}: 本地目录不是 git 仓库（${mainPath ?? "路径缺失"}）`)
              continue
            }
            localMapped += 1
            continue
          }
          const org = entry.group || entry.org || row.org || ""
          if (!org) { failed.push(`${entry.name}: 仓库未指定 org`); continue }
          const res = ensureRepoCloned(org, entry.name)
          if ("error" in res) failed.push(`${entry.name}: ${res.error}`)
          else orgCloned += 1
        }
        // Partial clone failure does not block the whole gate (plan risk #3):
        // succeeded repos proceed; failed ones are re-clonable from S5 later.
        if (failed.length === repoEntries.length) throw new Error(`全部失败：${failed.join("；")}`)
        const summary = `${orgCloned} 个仓库就绪 · ${localMapped} 个本地映射`
        item.sub = failed.length > 0 ? `${summary}（部分失败：${failed.join("；")}）` : summary
        return
      }
      case "mainline": {
        // 本轮口径（design 21 §1.6 ⑤⑥ / plan 22 §2.5）：只登记项目与主线，
        // **不预建 worktree**。ORG 主仓只拉主线（syncToDefaultBranch 的镜像语义
        // 天然保证「主仓永远干净且在默认分支」）；worktree 由作业或显式动作开。
        const config = readCabinConfig(row.path)
        const repoEntries = config.repos.filter((r) => r.name)
        if (repoEntries.length === 0) { item.sub = "无仓库"; return }
        const registered: CabinRepoEntry[] = []
        const failed: string[] = []
        for (const entry of repoEntries) {
          if (repoSource(entry) === "local") {
            const { mainPath } = resolveCabinRepo(row.path, entry)
            if (!mainPath || !isGitRepo(mainPath)) {
              failed.push(`${entry.name}: 本地目录不可用`)
              continue
            }
            const info = readLocalRepoInfo(mainPath)
            registered.push(mergeCabinRepoEntry(row.path, {
              ...entry,
              source: "local",
              main_path: mainPath,
              mainline_branch: entry.mainline_branch ?? info.branch ?? undefined,
            }))
            continue
          }
          const org = entry.group || entry.org || row.org || ""
          if (!org) { failed.push(`${entry.name}: 仓库未指定 org`); continue }
          const res = ensureRepoCloned(org, entry.name)
          if ("error" in res) { failed.push(`${entry.name}: ${res.error}`); continue }
          // Per-repo serial: syncToDefaultBranch force-aligns the shared org
          // mirror; concurrent syncs of the same mirror would race (risk #1).
          let mainline = entry.mainline_branch
          try {
            const synced = await gitOps.syncToDefaultBranch(res.localPath)
            mainline = synced.branch
          } catch (err) {
            failed.push(`${entry.name}: ${errMsg(err)}`)
          }
          registered.push(mergeCabinRepoEntry(row.path, {
            ...entry,
            source: "org",
            org,
            group: entry.group || org,
            repoName: entry.repoName || entry.name,
            main_path: res.localPath,
            mainline_branch: mainline,
            // 明确清掉旧形态里可能残留的 worktree 字段（老舱重试门禁时）。
            worktree_path: entry.worktree_path,
            branch: entry.branch,
          }))
        }
        this.writeProjectsClaudeMd(row, registered)
        if (failed.length > 0) {
          throw new Error(`项目登记失败：${failed.join("；")}`)
        }
        item.sub = `${registered.length} 个项目登记 · 未预建工作树`
        return
      }
      case "skeleton": {
        const cabinDir = path.join(row.path, ".cabin")
        fs.mkdirSync(cabinDir, { recursive: true })
        const names = readCabinConfig(row.path).repos.map((r) => r.name).filter(Boolean)
        const identity = {
          id: row.id, name: row.name, path: row.path, org: row.org,
          repos: names, workspace_id: row.workspace_id, main_session_id: row.main_session_id,
          createdAt: row.created_at,
        }
        const hash = createHash("sha256").update(JSON.stringify(identity), "utf-8").digest("hex")
        const manifest = { ...identity, hash }
        const tmp = path.join(cabinDir, "manifest.json.tmp")
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8")
        fs.renameSync(tmp, path.join(cabinDir, "manifest.json"))
        fs.writeFileSync(path.join(cabinDir, "context.md"), [
          `# 作战舱：${row.name}`, "",
          `- 目录：${row.path}`,
          `- org：${row.org ?? "（无）"}`,
          `- 仓库：${names.length > 0 ? names.join("、") : "（无）"}`,
          `- 主线策略：${row.mainline_strategy}`, "",
          "本舱是长期存活实体；归档为软封存，可重开。", "",
        ].join("\n"), "utf-8")
        return
      }
      case "requirements": {
        const cabinDir = path.join(row.path, ".cabin")
        fs.mkdirSync(cabinDir, { recursive: true })
        const content = row.requirements.trim() !== "" ? row.requirements : "# 需求\n\n（待补充）\n"
        fs.writeFileSync(path.join(cabinDir, "requirements.md"), content, "utf-8")
        return
      }
      case "first-plan": {
        if (!row.main_session_id) throw new Error("舱主会话缺失，无法发起首批任务提案回合")
        const runner = this.deps.runOrchestratorTurn ?? defaultOrchestratorTurn
        const message = `作战舱「${row.name}」已就绪（目录/git/仓库/主线/骨架/需求门禁全部通过）。` +
          `请阅读 .cabin/requirements.md，给出首批任务建议（按优先级排列；仅建议，不派发；派发任务需用户确认）。`
        await runner(row.main_session_id, message, row.org)
        item.sub = "首批任务建议已生成，待调度者细化"
        return
      }
      default:
        throw new Error(`unknown gate item: ${item.key}`)
    }
  }

  /** 舱目录的 CLAUDE.md：项目清单 + 只读门槛 + 开工作树的命令。
   *  Agent 起来就读得到「哪些仓库只读、要改怎么开工作树」，不靠记忆。 */
  private writeProjectsClaudeMd(row: CabinRow, entries: CabinRepoEntry[]): void {
    const lines: string[] = [
      `# 作战舱：${row.name}`, "",
      "## 项目（只读引用 · 不搬代码）", "",
    ]
    if (entries.length === 0) {
      lines.push("（还没有关联项目）", "")
    }
    for (const entry of entries) {
      const { mainPath } = resolveCabinRepo(row.path, entry)
      const kind = repoSource(entry) === "local"
        ? (entry.external ? "外部目录" : "本地目录")
        : `ORG ${entry.org || entry.group || ""}`
      lines.push(`- **${entry.name}** — ${kind} · \`${projectKey(entry)}\``)
      if (mainPath) lines.push(`  - 主仓：\`${mainPath}\`（只读）`)
      lines.push(`  - 主线：${entry.mainline_branch ?? "（未探测）"}`)
      lines.push(
        `  - 要改：开工作树 —— \`git -C "${mainPath ?? ""}" worktree add ` +
        `"${row.path}/projects/<instance>/${entry.name}" -b <branch>\``,
      )
    }
    lines.push(
      "",
      "## 门槛",
      "- 上述主仓一律只读：唯一允许的写向动作是拉主线（fetch + pull --ff-only）。",
      "- 任何编辑都发生在工作树里；建舱不预建工作树，按作业或显式动作开。",
      "- 任务天然在自己的 workspace 里建工作树，不会写主仓。",
      "",
    )
    fs.writeFileSync(path.join(row.path, "CLAUDE.md"), lines.join("\n"), "utf-8")
  }

  // ── persistence / streaming ────────────────────────────────────────

  private persist(row: CabinRow, state: CabinInitState): void {
    const cabinDir = path.join(row.path, ".cabin")
    fs.mkdirSync(cabinDir, { recursive: true })
    const tmp = path.join(cabinDir, "init-state.json.tmp")
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8")
    fs.renameSync(tmp, path.join(cabinDir, "init-state.json"))
    const fresh = this.deps.cabin.findById(row.id)
    if (fresh) {
      this.deps.cabin.updateFields(row.id, fresh.version, { init_state: JSON.stringify(state) }, now())
    }
  }

  private emitProgress(cabinId: string, state: CabinInitState): void {
    this.deps.sse.emit(`cabin:${cabinId}`, {
      event: "cabin_init_progress",
      data: { cabin_id: cabinId, items: state.items },
    })
  }

  private card(row: CabinRow, state: CabinInitState, status: "running" | "done" | "failed"): void {
    if (!row.main_session_id) return
    try {
      getChatEventBridge().requestCabinInitGateCard({
        sessionId: row.main_session_id,
        workspaceId: row.workspace_id,
        cabinId: row.id,
        cabinName: row.name,
        status,
        items: state.items.map((i) => ({
          key: i.key, label: i.label, state: i.state, error: i.error, fix_hint: i.fix_hint,
        })),
      })
    } catch {
      // Bridge not attached (unit tests) — progress still streams via SSE.
    }
  }
}