// packages/server/src/services/knowledge/pack-ops.ts
//
// 素材包运维面 — P3 票02（剔除重编译 / 包视图）。
//
// 红线纪律：
//  * **红线2**：重编译一律经全局串行队列（enqueue "archive-compile"），禁直写 wiki；
//    本服务只写 raw 层 manifest（可变索引，raw 冻结面的例外已在契约模块声明）。
//  * **红线3**：剔除 = 人裁素材源（Karpathy: human curates sources），**不是审批**——
//    没有待审队列/审批态；manifest 记 excluded 标记 + recompiles 审计行，即时生效。
//  * opKind 单源枚举复用 archive-compile（票面：opKind 复用/扩枚举由实现定——重编译仍是
//    归档编译，扩枚举唯一入口是 WRITE_OP_KINDS，此处不旁路）。
//
// 队列任务 id 确定性：`arc-{taskId}-rc{N}`（N = recompiles 计数 +1），
// GET /api/knowledge/wiki/queue/task/arc-{taskId}-rcN 可查位次/状态（Lane B 复用票06 面）。

import fs from "fs"
import path from "path"
import { getRawDir } from "./global-paths"
import type { WriteQueue } from "./wiki/compile-queue"
import {
  packActiveItems,
  packDigest,
  packDirRel,
  packManifestRel,
  readPackManifest,
  writePackManifest,
  type MaterialPackManifest,
} from "./material-pack"

const TASK_ID_RE = /^[A-Za-z0-9._-]+$/
const LEGACY_SUMMARY_RE = /^task-[A-Za-z0-9._-]+-summary\.md$/

export class PackOpsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "PackOpsError"
  }
}

export interface PackOpsDeps {
  root: string
  queue: WriteQueue
  compilePack: (taskId: string, opts?: { focus?: string }) => Promise<unknown>
  now?: () => Date
}

export interface PackView {
  taskId: string
  legacy?: boolean
  rawPath?: string
  packPath?: string
  manifestPath?: string
  digest?: string
  createdAt?: string
  updatedAt?: string
  items: Array<{ kind: string; name: string; path: string; bytes: number; sha256: string; excluded: boolean }>
  recompiles: MaterialPackManifest["recompiles"]
}

export interface RecompileAck {
  queueTaskId: string
  excludedPath: string | null
  focus: string | null
  manifestHash: string
  opKind: string
}

export class MaterialPackOpsService {
  private readonly deps: PackOpsDeps
  private readonly now: () => Date

  constructor(deps: PackOpsDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
  }

  /** 包视图：manifest 在盘给包形态；旧单文件给 legacy 兼容面（不迁移不报错）；皆无 404。 */
  getPack(taskId: string): PackView {
    if (!TASK_ID_RE.test(taskId)) throw new PackOpsError("INVALID_PARAM", `taskId 含非法字符: ${taskId}`, 400)
    const manifest = readPackManifest(this.deps.root, taskId)
    if (manifest) {
      return {
        taskId,
        packPath: packDirRel(taskId),
        manifestPath: packManifestRel(taskId),
        digest: packDigest(manifest),
        createdAt: manifest.createdAt,
        ...(manifest.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
        items: manifest.items.map(i => ({ kind: i.kind, name: i.name, path: i.path, bytes: i.bytes, sha256: i.sha256, excluded: i.excluded === true })),
        recompiles: manifest.recompiles,
      }
    }
    const legacyName = `task-${taskId}-summary.md`
    if (LEGACY_SUMMARY_RE.test(legacyName) && fs.existsSync(path.join(getRawDir(this.deps.root, "archives"), legacyName))) {
      return { taskId, legacy: true, rawPath: `raw/archives/${legacyName}`, items: [], recompiles: [] }
    }
    throw new PackOpsError("PACK_NOT_FOUND", `素材包不存在（也无历史单文件归档）: ${taskId}`, 404)
  }

  /**
   * 重编译（票02 素材包卡「剔除某件→重编译钮」+ 对话焦点重编译的确定性端点）：
   * 同包、manifest 减去被剔件（excluded 标记），入全局串行队列 archive-compile。
   */
  recompile(taskId: string, input: { excludePath?: unknown; focus?: unknown }): RecompileAck {
    if (!TASK_ID_RE.test(taskId)) throw new PackOpsError("INVALID_PARAM", `taskId 含非法字符: ${taskId}`, 400)
    const manifest = readPackManifest(this.deps.root, taskId)
    if (!manifest) throw new PackOpsError("PACK_NOT_FOUND", `素材包不存在: ${taskId}（历史单文件归档无包，不支持剔除重编译）`, 404)

    const focus = typeof input.focus === "string" && input.focus.trim() !== "" ? input.focus.trim() : null
    let excludedPath: string | null = null
    if (input.excludePath !== undefined && input.excludePath !== null && input.excludePath !== "") {
      if (typeof input.excludePath !== "string") throw new PackOpsError("INVALID_PARAM", "excludePath 须为字符串", 400)
      const want = input.excludePath.replace(/\\/g, "/")
      // 只许剔包内活跃件（路径必须逐字命中 manifest；穿越串自然命不中）
      const target = manifest.items.find(i => i.path === want)
      if (!target) throw new PackOpsError("INVALID_PARAM", `excludePath 不是包内件: ${want}`, 400)
      if (target.excluded) throw new PackOpsError("ALREADY_EXCLUDED", `该件已剔除: ${want}`, 409)
      if (manifest.items.filter(i => !i.excluded && i.kind === "archive-summary").length === 1 && target.kind === "archive-summary") {
        throw new PackOpsError("INVALID_PARAM", "总结件是编译主源，不可剔除（剔它等于取消本次归档编译）", 400)
      }
      target.excluded = true
      excludedPath = want
    }

    if (excludedPath === null && focus === null) {
      throw new PackOpsError("INVALID_PARAM", "recompile 需要 excludePath 或 focus 至少一项（空重编译请走 POST /compile）", 400)
    }

    const queueTaskId = `arc-${taskId}-rc${manifest.recompiles.length + 1}`
    manifest.recompiles.push({
      at: this.now().toISOString(),
      excludePath: excludedPath,
      focus: focus,
      queueTaskId,
    })
    manifest.updatedAt = this.now().toISOString()
    writePackManifest(this.deps.root, taskId, manifest)

    // **红线2**：wiki 写永远经全局串行队列——这里只入队，不直接编译。
    this.deps.queue.enqueue(
      "archive-compile",
      () => this.deps.compilePack(taskId, focus ? { focus } : {}),
      { taskId: queueTaskId, label: packManifestRel(taskId) },
    )

    const after = readPackManifest(this.deps.root, taskId)!
    return {
      queueTaskId,
      excludedPath,
      focus,
      manifestHash: packDigest(after),
      opKind: "archive-compile",
    }
  }
}

/** 编译读包的活跃件面（供断言/巡检复用：manifest 减去被剔件）。 */
export function activeItemsOf(manifest: MaterialPackManifest) {
  return packActiveItems(manifest)
}
