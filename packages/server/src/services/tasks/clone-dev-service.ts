// packages/server/src/services/tasks/clone-dev-service.ts
//
// clone-dev task kind (2026-11-25) — 分身开发/维护任务的服务端。
//
// 与 workflow-dev 同构：状态存在 `task_spec.clone_dev`，不走工作流引擎。
// 本服务负责四件事：
//   1) 写分身开发状态（meta / kit 声明）
//   2) 跑三条硬验证（工具可用 / 越权被拦 / 身份可用），证据落 task home
//   3) 开发完成闸门（三条全绿才能 complete，置 draft→ready 并发 awaiting_archive）
//   4) 合入时装 kit（仓库 → 用户分身目录）
//
// 任务级完成之后交给既有归档链路；本文件不做 git merge（那是 ArchiveService 的事）。

import fs from "node:fs"
import path from "node:path"
import type Database from "better-sqlite3"
import { cloneDevStateSchema, type CloneDevState } from "@octopus/shared"
import { TaskDAO } from "../../db/dao"
import type { TaskRow } from "../../db/types"
import { TaskHomeService } from "./task-home-service"
import { getCloneDir, getCloneSkillsDir } from "../agent/paths"
import {
  createUserClone,
  deleteUserClone,
  isValidCloneName,
  resolveCloneInfo,
} from "../agent/clone-resolver"
import { resolveCloneFilePath } from "../agent/clone-paths"
import {
  clearCloneKitCache,
  findRepoRoot,
  kitContext,
  loadCloneKit,
  type KitToolResult,
} from "../agent/clone-kit-registry"

export type CloneDevMode = "create" | "edit"

export class CloneDevError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "CloneDevError"
  }
}

export interface CloneDevDeps {
  db: Database.Database
  taskDAO?: TaskDAO
  taskHomeService?: TaskHomeService
  /** SSE bridge (taskpool/task_status). Optional in tests. */
  emitTaskStatus?: (taskId: string, status: string) => void
}

export interface CloneDevSnapshot {
  taskId: string
  kind: "clone-dev"
  state: CloneDevState
  clone: { info: ReturnType<typeof resolveCloneInfo>; dir: string } | null
}

function parseSpec(row: TaskRow): Record<string, unknown> {
  try {
    return JSON.parse(row.task_spec || "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 状态缺省值：mode=create、type=user、stage=draft。 */
function ensureCloneDev(spec: Record<string, unknown>, cloneName: string): CloneDevState {
  return cloneDevStateSchema.parse({
    mode: "create",
    clone_type: "user",
    stage: "draft",
    ...(spec.clone_dev as Record<string, unknown> | undefined),
    clone_name: (spec.clone_dev as { clone_name?: string } | undefined)?.clone_name ?? cloneName,
  })
}

export class CloneDevService {
  private readonly taskDAO: TaskDAO
  private readonly taskHomeService: TaskHomeService
  private readonly emitTaskStatus?: (taskId: string, status: string) => void

  constructor(deps: CloneDevDeps) {
    this.taskDAO = deps.taskDAO ?? new TaskDAO(deps.db)
    this.taskHomeService = deps.taskHomeService ?? new TaskHomeService()
    this.emitTaskStatus = deps.emitTaskStatus
  }

  // ── plumbing ────────────────────────────────────────────────────────

  private task(taskId: string): TaskRow {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new CloneDevError(404, `task ${taskId} not found`)
    const spec = parseSpec(row)
    if (spec.kind !== "clone-dev") throw new CloneDevError(400, `task ${taskId} is not a clone-dev task`)
    return row
  }

  private cloneNameOf(row: TaskRow): string {
    const spec = parseSpec(row)
    const name = (spec.clone_dev as { clone_name?: string } | undefined)?.clone_name
    if (!name || !isValidCloneName(name)) {
      throw new CloneDevError(409, "分身尚未命名：先让 Agent 用 clone_dev_set_meta 写入 clone_name")
    }
    return name
  }

  private updateSpec(
    taskId: string,
    mutate: (spec: Record<string, unknown>) => void,
    extra: Record<string, unknown> = {},
  ): void {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.taskDAO.getById(taskId)
      if (!row) throw new CloneDevError(404, `task ${taskId} not found`)
      const spec = parseSpec(row)
      const name = (spec.clone_dev as { clone_name?: string } | undefined)?.clone_name ?? "unnamed"
      mutate(spec)
      spec.clone_dev = ensureCloneDev(spec, name)
      const result = this.taskDAO.updateWithVersion(
        taskId,
        { task_spec: JSON.stringify(spec), ...extra },
        row.version,
      )
      if ((result.changes ?? 0) > 0) {
        this.taskHomeService.writeManifestFile(taskId, {
          version: 1,
          spec,
          updated_at: new Date().toISOString(),
          ...(spec.format === "v4" ? { format: "v4" } : {}),
        })
        return
      }
    }
    throw new CloneDevError(409, "task spec changed concurrently — retry")
  }

  // ── state ───────────────────────────────────────────────────────────

  getState(taskId: string): CloneDevSnapshot {
    const row = this.task(taskId)
    const spec = parseSpec(row)
    const name = this.cloneNameOf(row)
    const state = ensureCloneDev(spec, name)
    const info = resolveCloneInfo(name)
    return {
      taskId,
      kind: "clone-dev",
      state,
      clone: info ? { info, dir: getCloneDir(name) } : null,
    }
  }

  /** Agent 在会话里声明分身身份与工具清单。 */
  setMeta(
    taskId: string,
    input: {
      clone_name: string
      mode?: CloneDevMode
      clone_type?: "built-in" | "user"
      display_name?: string
      kit_enabled?: boolean
      tools?: string[]
    },
  ): CloneDevSnapshot {
    if (!isValidCloneName(input.clone_name)) {
      throw new CloneDevError(400, "clone_name 必须是 1-50 位小写字母/数字/连字符")
    }
    const row = this.task(taskId)
    const existing = parseSpec(row)
    const before = (existing.clone_dev as { clone_name?: string } | undefined)?.clone_name
    if (before && before !== input.clone_name && existing.clone_dev) {
      throw new CloneDevError(409, `clone_name 已锁定为 ${before}，代号不可中途改名`)
    }
    this.updateSpec(taskId, (spec) => {
      const dev = ensureCloneDev(spec, input.clone_name)
      dev.clone_name = input.clone_name
      dev.mode = input.mode ?? dev.mode
      dev.clone_type = input.clone_type ?? dev.clone_type
      dev.kit = {
        enabled: input.kit_enabled ?? (input.tools?.length ?? 0) > 0,
        package: input.kit_enabled === false ? undefined : `packages/clone-kits/${input.clone_name}`,
        tools: input.tools ?? dev.kit?.tools ?? [],
      }
      spec.clone_dev = dev
    })
    // create 模式下顺手建用户分身目录（persona/skills 是用户数据，不在主分支里）。
    const state = this.getState(taskId).state
    if (state.mode === "create" && state.clone_type === "user" && !resolveCloneInfo(input.clone_name)) {
      const created = createUserClone({
        name: input.clone_name,
        display_name: input.display_name ?? input.clone_name,
        persona: "（人格待写入）",
        skills: [],
        memory_scope: "isolated",
      })
      if (!created.ok) throw new CloneDevError(409, created.error)
    }
    return this.getState(taskId)
  }

  // ── verify ──────────────────────────────────────────────────────────

  /** 三条硬判据。返回快照；证据写 artifacts/clone-verify/<name>.json。 */
  async verify(taskId: string): Promise<CloneDevSnapshot> {
    const row = this.task(taskId)
    const name = this.cloneNameOf(row)
    const state = ensureCloneDev(parseSpec(row), name)
    const evidence: string[] = []
    const notes: string[] = []

    // ① 工具可用：kit 声明的每个工具自检通过（无 kit 视为跳过）
    let toolsCalled = true
    let kitGuardOk: boolean | null = null
    if (state.kit?.enabled) {
      const loaded = await loadCloneKit(name).catch((err: unknown) => {
        notes.push(`kit 加载失败：${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      if (!loaded) {
        toolsCalled = false
      } else {
        const ctx = kitContext(name, loaded.entry)
        const results: KitToolResult[] = loaded.module.selfTest
          ? await loaded.module.selfTest(ctx)
          : []
        const failed = results.filter((r) => !r.ok)
        const guard = results.find((r) => r.name === "boundary_guard")
        kitGuardOk = guard ? guard.ok : null
        toolsCalled = results.length > 0 && failed.length === 0
        evidence.push(`kit ${loaded.entry}`)
        for (const r of results) evidence.push(`tool ${r.name}: ${r.ok ? "ok" : "fail"}${r.detail ? ` (${r.detail})` : ""}`)
        if (failed.length > 0) notes.push(`工具自检失败：${failed.map((f) => f.name).join(", ")}`)
      }
    } else {
      notes.push("无工具分身：跳过工具自检")
    }

    // ② 越权被拦：同一份路径守卫必须拒绝穿越路径、放行合法路径
    const blockedTraversal = resolveCloneFilePath(name, "../../etc/passwd") === null
    const allowedInside = resolveCloneFilePath(name, "persona.md") !== null
    const boundaryBlocked = (kitGuardOk ?? blockedTraversal) && allowedInside
    evidence.push(`boundary traversal=${blockedTraversal} inside=${allowedInside} kitGuard=${kitGuardOk}`)

    // ③ 身份可用：分身目录、persona、skills 目录齐全
    const info = resolveCloneInfo(name)
    const personaPath = path.join(getCloneDir(name), "persona.md")
    const persona = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, "utf-8").trim() : ""
    const identitySwitch = Boolean(info) && persona.length > 0 && fs.existsSync(getCloneSkillsDir(name, "user"))
    evidence.push(`identity=${Boolean(info)} persona=${persona.length}b skills=${fs.existsSync(getCloneSkillsDir(name, "user"))}`)
    if (!identitySwitch) notes.push("身份检查未通过：确认 persona.md 非空且分身目录存在")

    const allGreen = toolsCalled && boundaryBlocked && identitySwitch
    this.updateSpec(taskId, (spec) => {
      const dev = ensureCloneDev(spec, name)
      dev.verification = {
        tools_called: toolsCalled,
        boundary_blocked: boundaryBlocked,
        identity_switch: identitySwitch,
        evidence,
        ran_at: new Date().toISOString(),
        message: notes.join("; ") || undefined,
      }
      dev.stage = allGreen ? "verified" : "draft"
      spec.clone_dev = dev
    })

    this.writeEvidence(taskId, name, {
      at: new Date().toISOString(),
      clone: name,
      tools_called: toolsCalled,
      boundary_blocked: boundaryBlocked,
      identity_switch: identitySwitch,
      evidence,
      notes,
    })
    return this.getState(taskId)
  }

  private writeEvidence(taskId: string, name: string, body: unknown): void {
    try {
      const dir = path.join(this.taskHomeService.artifactsDir(taskId), "clone-verify")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2), "utf-8")
    } catch {
      // 证据落盘失败不阻断验证本身
    }
  }

  /** 开发完成闸门：三条全绿才允许，随后 draft→ready + awaiting_archive。 */
  completeTask(taskId: string): CloneDevSnapshot {
    const row = this.task(taskId)
    if (["archiving", "done", "aborted"].includes(row.status)) {
      throw new CloneDevError(409, `task is already ${row.status}`)
    }
    const name = this.cloneNameOf(row)
    const state = ensureCloneDev(parseSpec(row), name)
    const v = state.verification
    const missing = [
      !v?.tools_called ? "工具可用" : null,
      !v?.boundary_blocked ? "越权被拦" : null,
      !v?.identity_switch ? "身份可用" : null,
    ].filter(Boolean)
    if (missing.length > 0) {
      throw new CloneDevError(409, `验证未通过（缺：${missing.join("、")}）。先跑 clone_dev_verify`)
    }
    this.updateSpec(
      taskId,
      (spec) => {
        const dev = ensureCloneDev(spec, name)
        dev.complete = true
        dev.stage = "verified"
        spec.clone_dev = dev
      },
      row.status === "draft" ? { status: "ready" } : {},
    )
    this.emitTaskStatus?.(taskId, "awaiting_archive")
    return this.getState(taskId)
  }

  // ── install ─────────────────────────────────────────────────────────

  /** 合入时把仓库里的 kit 构建产物装进用户分身目录（合入即安装）。 */
  installKit(taskId: string): { installed: boolean; target?: string } {
    const row = this.task(taskId)
    const name = this.cloneNameOf(row)
    const state = ensureCloneDev(parseSpec(row), name)
    if (!state.kit?.enabled) return { installed: false }
    const repoRoot = findRepoRoot()
    if (!repoRoot) throw new CloneDevError(500, "找不到仓库根（packages/clone-kits）")
    const src = path.join(repoRoot, "packages", "clone-kits", "dist")
    if (!fs.existsSync(path.join(src, name, "index.js"))) {
      throw new CloneDevError(409, `kit 尚未构建：packages/clone-kits/dist/${name}/index.js 不存在`)
    }
    const dst = path.join(getCloneDir(name), "kit", "dist")
    fs.rmSync(path.join(getCloneDir(name), "kit"), { recursive: true, force: true })
    fs.mkdirSync(dst, { recursive: true })
    fs.cpSync(src, dst, { recursive: true })
    fs.writeFileSync(
      path.join(getCloneDir(name), "kit", "kit.json"),
      JSON.stringify(
        {
          name,
          package: state.kit.package,
          tools: state.kit.tools,
          installed_at: new Date().toISOString(),
          source: src,
        },
        null,
        2,
      ),
      "utf-8",
    )
    clearCloneKitCache(name)
    this.updateSpec(taskId, (spec) => {
      const dev = ensureCloneDev(spec, name)
      dev.stage = "merged"
      dev.runtime = { ...dev.runtime, installed_at: new Date().toISOString() }
      spec.clone_dev = dev
    })
    return { installed: true, target: path.join(getCloneDir(name), "kit") }
  }

  /** 卸载：删用户分身目录 + 注销 DB 行，不触碰核心。 */
  uninstall(name: string): { ok: true } {
    const result = deleteUserClone(name)
    if (!result.ok) throw new CloneDevError(result.status ?? 500, result.error)
    clearCloneKitCache(name)
    return { ok: true }
  }
}

// ── process-wide singleton (routes + chat tools) ─────────────────────

let singleton: CloneDevService | null = null

export function initCloneDevService(deps: CloneDevDeps): CloneDevService {
  singleton = new CloneDevService(deps)
  return singleton
}

export function getCloneDevService(): CloneDevService | null {
  return singleton
}
