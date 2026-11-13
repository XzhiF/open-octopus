// packages/server/src/services/cabin/cabin-init-service.ts
//
// CabinInitService — the one genuinely new orchestration in Cabin P1: an
// agent-driven setup gate modeled on InitService.initAgent idempotence +
// archiving per-item resume. Gates 1–6 are deterministic service calls (no
// LLM); gate 7 (first-iteration proposal) is a real orchestrator turn through
// the normal chat endpoint (self-POST, same path ChatEventBridge.wake uses).
//
// Truth on disk: .cabin/init-state.json (per-item resume) + .cabin/manifest.json
// (identity, hash-stamped). cabins.init_state is only a cold-load mirror.
// Progress streams on SSE channel `cabin:<id>`; milestone cards land in the
// cabin main transcript via ChatEventBridge (zero LLM).

import fs from "fs"
import path from "path"
import { createHash, randomUUID } from "crypto"
import { spawnSync } from "child_process"
import type { CabinInitState } from "@octopus/shared"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type { CabinRow } from "../../db/types"
import type { SSEService } from "../sse"
import { WorkspaceGit, type SpecWorktreeEntry } from "../workspace-git"
import { gitOps } from "../git-ops"
import { getChatEventBridge } from "../activity/chat-event-bridge"
import { ensureRepoCloned, readCabinConfig } from "./cabin-repos"

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
  { key: "clone", label: "克隆仓库", fixHint: "检查 org 仓库注册表与 git 认证", deepLink: "repos" },
  { key: "mainline", label: "主线分支", fixHint: "检查网络/远端后重试；worktree 失败去仓库模块", deepLink: "repos" },
  { key: "skeleton", label: "舱骨架 .cabin/", fixHint: "检查目录写权限", deepLink: "settings" },
  { key: "requirements", label: "需求落盘", fixHint: "检查目录写权限", deepLink: "settings" },
  { key: "first-iteration", label: "首迭代提案", fixHint: "检查模型服务配置后重试门禁", deepLink: "settings" },
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
        const names = readCabinConfig(row.path).repos.map((r) => r.name).filter(Boolean)
        if (names.length === 0) { item.sub = "无仓库"; return }
        if (!row.org) throw new Error("请求了仓库但舱未指定 org")
        const failed: string[] = []
        for (const name of names) {
          const res = ensureRepoCloned(row.org, name)
          if ("error" in res) failed.push(`${name}: ${res.error}`)
        }
        // Partial clone failure does not block the whole gate (plan risk #3):
        // succeeded repos proceed; failed ones are re-clonable from S5 later.
        if (failed.length === names.length) throw new Error(`全部克隆失败：${failed.join("；")}`)
        item.sub = failed.length > 0 ? `部分失败：${failed.join("；")}` : `${names.length} 个仓库就绪`
        return
      }
      case "mainline": {
        const config = readCabinConfig(row.path)
        const names = config.repos.map((r) => r.name).filter(Boolean)
        if (names.length === 0) { item.sub = "无仓库"; return }
        const branch = `cabin-${row.id.slice(0, 8)}`
        const entries: SpecWorktreeEntry[] = []
        const syncFailed: string[] = []
        for (const name of names) {
          const res = ensureRepoCloned(row.org ?? "", name)
          if ("error" in res) { syncFailed.push(`${name}: ${res.error}`); continue }
          // Per-repo serial: syncToDefaultBranch force-aligns the shared org
          // mirror; concurrent syncs of the same mirror would race (risk #1).
          try {
            await gitOps.syncToDefaultBranch(res.localPath)
          } catch (err) {
            syncFailed.push(`${name}: ${errMsg(err)}`)
          }
          try {
            entries.push(this.git.initWorktreeOne(row.path, { name, source_path: res.localPath }, branch, row.org ?? ""))
          } catch (err) {
            throw new Error(`worktree 建立失败 '${name}': ${errMsg(err)}`)
          }
        }
        if (entries.length > 0) {
          // writeSpecWorktreeMeta writes config.json.repos[] (the contract
          // resolveRepoDir / resolveWorktree read) + CLAUDE.md in one pass.
          this.git.writeSpecWorktreeMeta(row.path, entries, config.name)
        }
        item.sub = syncFailed.length > 0
          ? `主线同步失败（worktree 按本地 HEAD 建立）：${syncFailed.join("；")}`
          : `${entries.length} 个 worktree 就绪`
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
      case "first-iteration": {
        if (!row.main_session_id) throw new Error("舱主会话缺失，无法发起首迭代提案回合")
        const runner = this.deps.runOrchestratorTurn ?? defaultOrchestratorTurn
        const message = `作战舱「${row.name}」已就绪（目录/git/仓库/主线/骨架/需求门禁全部通过）。` +
          `请阅读 .cabin/requirements.md，提出首个迭代 M1 的目标与首批任务建议` +
          `（仅提案，不派发；派发任务需用户确认）。`
        await runner(row.main_session_id, message, row.org)
        if (this.deps.cabin.listIterations(row.id).length === 0) {
          const ts = now()
          this.deps.cabin.insertIteration({
            id: randomUUID(), cabin_id: row.id, code: "M1", name: "首个迭代",
            sort_order: 0, status: "pending", created_at: ts, updated_at: ts,
          })
        }
        item.sub = "M1 已提案，待调度者细化"
        return
      }
      default:
        throw new Error(`unknown gate item: ${item.key}`)
    }
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