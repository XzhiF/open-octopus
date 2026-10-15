import fs from "fs"
import path from "path"
import { CuratorError, type CuratorCompileResult } from "./curator"
import { resolveKnowledgeRoot } from "../global-paths"

/**
 * 薄编译任务 registry — 知识中心票05 AC5；票06 起**投喂入口统一走全局 FIFO 队列**。
 *
 * 语义边界：**只做「投喂/显式触发 → task id → 状态可查」**——串行由队列保证：
 * 票06 全局写串行（owner 裁决：wiki 写入不许并发）把 `start(id)` 整包进
 * `CompileQueue`（进程内 FIFO + wiki 根锁保底），registry 与路由契约零改动——
 * 任务以 `crt-…` id 入队，`queued →（轮到才置）compiling → committed | failed`
 * 的位次/深度经队列 API 可查（`GET /api/knowledge/wiki/queue`，UI 票12 消费）。
 * 缺省（未注入 queue）= 服务私有 FIFO 队列（无跨进程锁，测试/离线形态）；
 * 生产装配（index.ts）注入**进程内全局单例**——投喂/归档/修订/lint 自纠/
 * finding 修复/revert/重蒸馏七类写操作共队互斥。
 *
 * 状态机：queued →（队列轮到才起跑）compiling → committed | failed。
 * 进程内 Map（最新 N 条，超容量逐出最老终态任务）；进程重启任务史丢——
 * 真相面是 git LOG 行（编译成功）或投喂回执重试（失败）。持久化任务表不在本票。
 */

import { CompileQueue, type WriteQueue } from "./compile-queue"

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
  /**
   * 票10 投喂泛化：发起会话 id（会话内意图路由投喂时由 SessionCurationService 传入）。
   * ADDITIVE——既有投喂/归档/重试等来源缺省无此位（Lane A 回流判据：仅带上下文的
   * 任务在终态时卡片回流原会话，知识中心 Lane B 形态零回归）。
   */
  sessionId?: string
}

export interface CuratorTaskDeps {
  /** 单次编译入口（票06 起经全局队列整包执行——同一时刻全局只有一个 run 在跑） */
  run: (rawPath: string) => Promise<CuratorCompileResult>
  /** 知识根（raw 存在性同步校验用）；缺省 resolveKnowledgeRoot() */
  root?: string
  now?: () => Date
  /** registry 容量（默认 200，逐出最老终态任务） */
  capacity?: number
  /** 全局写串行队列（票06）。缺省=服务私有 FIFO（无跨进程锁）；生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
}

const TERMINAL: CompileTaskStatus[] = ["committed", "failed"]

export class CuratorTaskService {
  private readonly tasks = new Map<string, CompileTaskRecord>()
  private seq = 0
  private readonly run: (rawPath: string) => Promise<CuratorCompileResult>
  private readonly root: string
  private readonly now: () => Date
  private readonly capacity: number
  private readonly queue: WriteQueue
  /** 票10：任务终态监听器（投喂泛化的回流钩子位；多个可挂，逐个吞错）。 */
  private readonly settledListeners: Array<(rec: CompileTaskRecord) => void> = []

  constructor(deps: CuratorTaskDeps) {
    this.run = deps.run
    this.root = resolveKnowledgeRoot(deps.root)
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
    this.queue = deps.queue ?? new CompileQueue()
  }

  /**
   * 挂终态监听：任务进入 committed/failed 时在队列执行体内回调（携记录，含
   * sessionId 上下文）。**监听器异常一律吞进 stderr**——回流失败不改编译任务态、
   * 不误报队列失败（报对话同律：显形不炸作业）。
   */
  attachSettledListener(cb: (rec: CompileTaskRecord) => void): void {
    this.settledListeners.push(cb)
  }

  /**
   * 投喂/显式触发入口：同步校验 raw 在盘（不存在 ⇒ 立即抛 CuratorError，路由直接 404，
   * 不建任务），返回 queued 记录；**编译不在这里起跑——入全局 FIFO 队列**（票06），
   * 轮到才 `start()`。回执先回、diff 卡后补（prototype Tab③「>10s 转异步」本期统一化：
   * 一切编译都异步且串行）。任务以 registry id 入队 ⇒ 位次 #N 经队列 API 可查。
   *
   * 票10 ADDITIVE：`opts.sessionId` = 发起会话上下文（记入记录、终态监听器消费——
   * 仅带此位的任务卡片回流原会话）。缺省不传 ⇒ 行为与旧形逐字一致。
   */
  submit(rawPath: string, opts?: { sessionId?: string }): CompileTaskRecord {
    const clean = rawPath.replace(/\\/g, "/")
    if (!clean.startsWith("raw/")) throw new CuratorError("INVALID_PARAM", `raw 路径须以 'raw/' 开头：${rawPath}`, 400)
    const abs = path.resolve(this.root, clean)
    if (!abs.startsWith(path.resolve(this.root, "raw") + path.sep)) {
      throw new CuratorError("INVALID_PARAM", `raw 路径逃逸知识根 raw/：${rawPath}`, 400)
    }
    if (!fs.existsSync(abs)) throw new CuratorError("RAW_NOT_FOUND", `raw 源不在盘：${rawPath}`, 404)

    const id = `crt-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: CompileTaskRecord = {
      id,
      rawPath: clean,
      status: "queued",
      createdAt: this.now().toISOString(),
      ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    }
    this.tasks.set(id, rec)
    this.evict()
    this.queue.enqueue("ingest-compile", async () => {
      await this.start(id)
      // registry 的 failed 对队列可见（否则 start() 自吞错误 ⇒ 队列误记 committed）
      const done = this.tasks.get(id)
      if (done && (done.status === "committed" || done.status === "failed")) {
        for (const cb of this.settledListeners) {
          try {
            cb(done)
          } catch (err) {
            process.stderr.write(`[wiki-compile-task] settled listener failed: ${err instanceof Error ? err.message : String(err)}\n`)
          }
        }
      }
      if (done?.status === "failed") {
        const code = done.error?.code ?? "COMPILE_FAILED"
        throw Object.assign(new Error(`${code}: ${done.error?.message ?? "编译失败"}`), { code })
      }
    }, { taskId: id, label: clean })
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
