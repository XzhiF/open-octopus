// packages/server/src/services/tasks/test-instance-registry.ts
//
// 测试实例注册表（2026-09-24，「自动回收 + 一键关闭」）。验收 runbook 的 `up`
// /探针 launcher 拉起的常驻进程（next dev、node server、java …）此前只活在内存
// 会话里 —— server 重启即失联，测试结束后无人回收，用户只能 netstat+taskkill。
//
// 本协议把「谁在听哪些端口」落盘（~/.octopus/instances/{taskId}.json），与
// ports/{safe}.json、host-pids.json 同族（文件即协议，进程死后仍可人工审计）。
// 端口反查是权威：up 可能秒退（detached launcher）、可能被重启甩脱，只有
// 「端口上谁在听」跨得住生命周期；shell_pid 只是前台长驻型的树杀兜底。
//
// 回收/关闭走 round-evidence-service 的 reclaim 编排；宿主保护（绝不杀
// pnpm dev 起的 Octopus 自身）在路由层的三重闸执行，本文件只记账不杀人。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { randomBytes } from "crypto"
import { findPidOnPort } from "../../port-utils"

export type InstanceSource = "preview-up" | "probe-launcher"
export type InstanceStatus = "alive" | "stale" | "stopped"

export interface InstanceDown {
  command: string
  cwd: string
}

export interface TestInstanceEntry {
  id: string
  source: InstanceSource
  exec_id?: string
  branch?: string
  workspace_path?: string
  /** BashExecutor 透出的 shell PID（前台长驻 up 的树杀根；秒退 launcher 无意义）。 */
  shell_pid?: number
  /** 端口反查到的 listener PID —— 权威。reconcile 时刷新。 */
  pids: number[]
  ports: number[]
  urls: string[]
  /** runbook down 快照（含绝对 cwd）—— 跨 server 重启也能先礼后兵。 */
  down?: InstanceDown
  started_at: string
  status: InstanceStatus
}

interface TestInstanceFile {
  version: 1
  task_id: string
  updated_at: string
  entries: TestInstanceEntry[]
}

export interface NewInstanceEntry {
  source: InstanceSource
  exec_id?: string
  branch?: string
  workspace_path?: string
  shell_pid?: number
  ports: number[]
  urls: string[]
  down?: InstanceDown
}

/** taskId → 安全文件名片段（与 dev.mjs safeName 同规则）。 */
function safeFilePart(s: string): string {
  return s.replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
}

export class TestInstanceRegistry {
  constructor(private readonly dir = path.join(os.homedir(), ".octopus", "instances")) {}

  private fileFor(taskId: string): string {
    return path.join(this.dir, `${safeFilePart(taskId)}.json`)
  }

  /** Read the raw file (no reconcile). Corrupt/missing → empty (honest
   *  degrade — never wipe siblings by pretending we own the file). */
  read(taskId: string): TestInstanceEntry[] {
    const fp = this.fileFor(taskId)
    if (!existsSync(fp)) return []
    try {
      const data = JSON.parse(readFileSync(fp, "utf-8")) as TestInstanceFile
      return Array.isArray(data?.entries) ? data.entries : []
    } catch (err: unknown) {
      console.warn(`[instance-registry] unreadable ${fp}:`, err instanceof Error ? err.message : err)
      return []
    }
  }

  private write(taskId: string, entries: TestInstanceEntry[]): void {
    const fp = this.fileFor(taskId)
    const tmp = `${fp}.${randomBytes(4).toString("hex")}.tmp`
    const data: TestInstanceFile = {
      version: 1,
      task_id: taskId,
      updated_at: new Date().toISOString(),
      entries,
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    try {
      renameSync(tmp, fp)
    } catch {
      // Windows: rename over an existing target can EPERM — replace explicitly.
      try { unlinkSync(fp) } catch { /* first write race */ }
      renameSync(tmp, fp)
    }
  }

  /** Register a freshly-started instance. ports may be empty (a probe whose
   *  ports surface later — reconcile re-derives pids from ports, so an entry
   *  with neither is born stale on its first read). */
  add(taskId: string, e: NewInstanceEntry): TestInstanceEntry {
    const entry: TestInstanceEntry = {
      id: `inst-${randomBytes(4).toString("hex")}`,
      source: e.source,
      exec_id: e.exec_id,
      branch: e.branch,
      workspace_path: e.workspace_path,
      shell_pid: e.shell_pid,
      pids: e.ports.flatMap((p) => findPidOnPort(p)),
      ports: [...e.ports],
      urls: [...e.urls],
      down: e.down,
      started_at: new Date().toISOString(),
      status: "alive",
    }
    this.write(taskId, [...this.read(taskId), entry])
    return entry
  }

  /** Read + reconcile: ports known → refresh pids via findPidOnPort (any hit
   *  = alive); ports unknown but shell alive = alive; else stale. Writes back
   *  only when something changed (reads stay cheap/idempotent). */
  listEntries(taskId: string): TestInstanceEntry[] {
    const entries = this.read(taskId)
    let changed = false
    for (const entry of entries) {
      if (entry.status === "stopped") continue
      const pids = entry.ports.flatMap((p) => findPidOnPort(p))
      let alive: boolean
      if (entry.ports.length > 0) {
        alive = pids.length > 0
        if (alive && !sameIds(pids, entry.pids)) { entry.pids = pids; changed = true }
      } else {
        alive = entry.shell_pid !== undefined && pidAlive(entry.shell_pid)
      }
      const next: InstanceStatus = alive ? "alive" : "stale"
      if (entry.status !== next) { entry.status = next; changed = true }
    }
    if (changed) {
      try { this.write(taskId, entries) } catch (err: unknown) {
        console.warn("[instance-registry] write-back failed:", err instanceof Error ? err.message : err)
      }
    }
    return entries
  }

  /** Mark entries stopped (reclaim 收尾). File is deleted when EVERYTHING is
   *  stopped — a stopped-but-respawned port would create a fresh entry anyway. */
  markStopped(taskId: string, entryIds?: string[]): TestInstanceEntry[] {
    const entries = this.read(taskId)
    const set = entryIds ? new Set(entryIds) : null
    for (const e of entries) {
      if (!set || set.has(e.id)) e.status = "stopped"
    }
    if (entries.every((e) => e.status === "stopped")) {
      try { unlinkSync(this.fileFor(taskId)) } catch { /* already gone */ }
      return entries
    }
    this.write(taskId, entries)
    return entries
  }

  /** Task ids with registry files (startup sweep). */
  listTaskIds(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSafe(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sameIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}
