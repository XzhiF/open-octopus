import fs from "fs"
import path from "path"
import { CuratorError, type CuratorCompileResult } from "./curator"
import { resolveKnowledgeRoot } from "../global-paths"

/**
 * 薄编译任务 registry — 知识中心票05 AC5。
 *
 * 语义边界：**只做「投喂/显式触发 → task id → 状态可查」**，不是队列——
 * 全局 FIFO 队列与 wiki 根锁是票06 的活（勿预建，spec §全局写串行）。
 * `run(rawPath)` 注入的是单次编译入口（CuratorCompileService.compileRaw 的包装），
 * 它同步 await 到终态、原子回滚零半成品——票06 把本服务外面整包上互斥即可，
 * registry 与路由契约零改动。
 *
 * 状态机：queued →（setImmediate 起跑）compiling → committed | failed。
 * 进程内 Map（最新 N 条，超容量逐出最老终态任务）；进程重启任务史丢——
 * 真相面是 git LOG 行（编译成功）或投喂回执重试（失败）。持久化任务表不在本票。
 */

export type CompileTaskStatus = "queued" | "compiling" | "committed" | "failed"

export interface CompileTaskRecord {
  id: string
  rawPath: string
  status: CompileTaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** 编译产物摘要（DIFF 卡数据面：触及页/新页数/矛盾数/commit hash） */
  result?: CuratorCompileResult
  /** 稳定错误面：code 取自 CuratorError；原始错文只进 stderr（errorResponse 纪律） */
  error?: { code: string; message: string }
}

export interface CuratorTaskDeps {
  /** 单次编译入口（票06 队列的整包对象） */
  run: (rawPath: string) => Promise<CuratorCompileResult>
  /** 知识根（raw 存在性同步校验用）；缺省 resolveKnowledgeRoot() */
  root?: string
  now?: () => Date
  /** registry 容量（默认 200，逐出最老终态任务） */
  capacity?: number
}

const TERMINAL: CompileTaskStatus[] = ["committed", "failed"]

export class CuratorTaskService {
  private readonly tasks = new Map<string, CompileTaskRecord>()
  private seq = 0
  private readonly run: (rawPath: string) => Promise<CuratorCompileResult>
  private readonly root: string
  private readonly now: () => Date
  private readonly capacity: number

  constructor(deps: CuratorTaskDeps) {
    this.run = deps.run
    this.root = resolveKnowledgeRoot(deps.root)
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
  }

  /**
   * 投喂/显式触发入口：同步校验 raw 在盘（不存在 ⇒ 立即抛 CuratorError，路由直接 404，
   * 不建任务），返回 queued 记录；编译在 setImmediate 起跑（回执先回、diff 卡后补——
   * prototype Tab③「>10s 转异步」形态的本期统一化：一切编译都异步）。
   */
  submit(rawPath: string): CompileTaskRecord {
    const clean = rawPath.replace(/\\/g, "/")
    if (!clean.startsWith("raw/")) throw new CuratorError("INVALID_PARAM", `raw 路径须以 'raw/' 开头：${rawPath}`, 400)
    const abs = path.resolve(this.root, clean)
    if (!abs.startsWith(path.resolve(this.root, "raw") + path.sep)) {
      throw new CuratorError("INVALID_PARAM", `raw 路径逃逸知识根 raw/：${rawPath}`, 400)
    }
    if (!fs.existsSync(abs)) throw new CuratorError("RAW_NOT_FOUND", `raw 源不在盘：${rawPath}`, 404)

    const id = `crt-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: CompileTaskRecord = { id, rawPath: clean, status: "queued", createdAt: this.now().toISOString() }
    this.tasks.set(id, rec)
    this.evict()
    setImmediate(() => { void this.start(id) })
    return rec
  }

  get(id: string): CompileTaskRecord | undefined {
    return this.tasks.get(id)
  }

  /** 快照列表（新在前；健康条队列深度 = status==="queued"|"compiling" 计数）。 */
  list(): CompileTaskRecord[] {
    return [...this.tasks.values()].reverse()
  }

  queueDepth(): number {
    let n = 0
    for (const t of this.tasks.values()) if (t.status === "queued" || t.status === "compiling") n++
    return n
  }

  private async start(id: string): Promise<void> {
    const rec = this.tasks.get(id)
    if (!rec || rec.status !== "queued") return
    rec.status = "compiling"
    rec.startedAt = this.now().toISOString()
    try {
      const result = await this.run(rec.rawPath)
      rec.result = result
      rec.status = "committed"
    } catch (err) {
      const code = err instanceof CuratorError ? err.code : "COMPILE_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      rec.error = { code, message: message.replace(new RegExp(`^${code}: `), "") }
      rec.status = "failed"
      process.stderr.write(`[wiki-compile-task] ${id} failed: ${message}\n`)
    } finally {
      rec.finishedAt = this.now().toISOString()
    }
  }

  private evict(): void {
    if (this.tasks.size <= this.capacity) return
    for (const [id, rec] of this.tasks) {
      if (TERMINAL.includes(rec.status)) {
        this.tasks.delete(id)
        if (this.tasks.size <= this.capacity) return
      }
    }
  }
}
