/**
 * CompileQueue — 进程内全局 FIFO 编译队列 — 知识中心票06 主控级。
 *
 * owner 裁决（2026-10-13，spec §全局写串行）：**wiki 写入不许并发，全局单串行**。
 * 一次编译 = 触 N 页 + INDEX 重建 + LOG append + FTS 同步 + git commit——并发必互踩
 * （git index 冲突、INDEX 竞态、锚点发号双花）。本队列是唯一写闸外层的第一级互斥
 * （进程内），wiki 根锁文件（wiki-lock.ts）是第二级保底（跨进程）。
 *
 * 语义（票面 AC2 / prototype Tab③）：
 * - 单异步互斥：同一时刻至多一个任务在跑；后到者排队，位次 #N 可查（UI 卡「排队中 #N」）。
 * - 全部写操作统一入队（WRITE_OP_KINDS 单源枚举，现八类：投喂/归档/对话修订/lint 自纠/
 *   finding 修复/revert/重蒸馏 + P3 票03 判例入档 case-archive）：此刻多数 kind 有
 *   实现体（curator/archive/case-archive/finding-fix/revert/redistill），dialog-revise/
 *   lint-fix 为预留入队通道——
 *   **任何写通道不得绕过本队列直写 wiki**（AC1）。
 * - 失败语义：单任务失败 ⇒ 自身标记 failed（编译事务回滚由写闸内部保证）⇒
 *   锁释放 ⇒ 队列继续，一次失败不堵死全队。
 * - 读永不锁：本队列与锁只约束写侧，读路径（tree/article/search/页 Read）零参与。
 *
 * 任务表为进程内 Map + FIFO 数组（最新 capacity 条，超容量逐出最老终态任务）；
 * 持久任务表不在本票——真相面是 git LOG 行。
 */

/** 写操作 kind 单源（票面 AC1 六类 + 重蒸馏脚本 + P3 票03 判例入档第八类；UI/脚本按值消费，禁各自造词）。 */
export const WRITE_OP_KINDS = [
  "ingest-compile",  // 投喂编译（票05 curator 任务入口）
  "archive-compile", // 归档编译（票10 归档自动投喂；P3 票02 素材包重编译同通道）
  "dialog-revise",   // 对话修订 fix-forward（票12）
  "lint-fix",        // lint 自纠（票12）
  "finding-fix",     // finding 修复裁决即编译（票13）
  "revert",          // 回滚 git revert（票12）
  "redistill",       // 重蒸馏脚本（票07）
  "case-archive",    // P3 票03 判例自动入档（提取草案/occurrences 合并/退役 superseded 全经此通道，红线2 禁直写 cases/）
] as const
export type WriteOpKind = (typeof WRITE_OP_KINDS)[number]

/** 任务状态机——与票05 CompileTaskRecord 同词（queued→running→committed/failed；UI「排队中 #N→编译中→已提交」）。 */
export type QueueTaskState = "queued" | "running" | "committed" | "failed"

export interface QueueTaskView {
  id: string
  opKind: WriteOpKind
  /** 展示标签（如 raw 路径/页 id），UI 卡消费；队列本体不解释其内容 */
  label?: string
  state: QueueTaskState
  /** 排队位次 #N：仅 state==="queued" 有值（1=下一个开跑）；在跑/终态为 null */
  position: number | null
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  /** 稳定错误面 {code,message}（errorResponse 纪律：原始错文只进 stderr） */
  error?: { code: string; message: string }
}

export interface EnqueueOpts {
  /** 调用方自备 id（curator registry 用 crt-… 保持票05 路由契约零改动）；缺省队列自发 wq-… */
  taskId?: string
  label?: string
}

/** 跨进程保底锁的 seam（wiki-lock.ts 实现；测试可注入假锁/关锁）。 */
export interface WriteLock {
  /** 持锁到 release；占用者活跳心跳未衰 ⇒ 抛 WikiLockError(LOCK_HELD) */
  acquire(meta: { opKind: WriteOpKind; taskId: string }): Promise<() => void>
}

/** 队列消费面（curator-task/路由只依赖此接口，不依赖类本体）。 */
export interface WriteQueue {
  enqueue(opKind: WriteOpKind, fn: () => Promise<unknown>, opts?: EnqueueOpts): QueueTaskView
  get(id: string): QueueTaskView | undefined
  list(): QueueTaskView[]
  /** 深度 = queued + running（尚未终态的任务数；健康条 queueDepth 消费） */
  depth(): number
}

interface QueueEntry {
  id: string
  opKind: WriteOpKind
  label?: string
  state: QueueTaskState
  fn: () => Promise<unknown>
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  error?: { code: string; message: string }
}

export interface CompileQueueDeps {
  /** 跨进程锁（缺省 null = 纯进程内串行；生产 index.ts 注入 wiki 根锁） */
  lock?: WriteLock | null
  now?: () => Date
  /** 任务表容量（默认 200，逐出最老终态任务；curator-task registry 同律） */
  capacity?: number
}

const TERMINAL_STATES: QueueTaskState[] = ["committed", "failed"]

function extractError(err: unknown): { code: string; message: string } {
  const anyErr = err as { code?: unknown; message?: unknown }
  const code = typeof anyErr?.code === "string" ? anyErr.code : "QUEUE_OP_FAILED"
  const raw = err instanceof Error ? err.message : String(err)
  return { code, message: raw.startsWith(`${code}: `) ? raw.slice(code.length + 2) : raw }
}

export class CompileQueue implements WriteQueue {
  private readonly entries: QueueEntry[] = []
  private readonly index = new Map<string, QueueEntry>()
  private running = false
  private seq = 0
  private readonly lock: WriteLock | null
  private readonly now: () => Date
  private readonly capacity: number

  constructor(deps: CompileQueueDeps = {}) {
    this.lock = deps.lock ?? null
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
  }

  /**
   * 入队即返回（state=queued 带位次）；执行在 setImmediate 起——与票05 submit 的
   * 「回执先回、diff 卡后补」时序一致。单互斥：只有队首且无在跑任务时开跑。
   */
  enqueue(opKind: WriteOpKind, fn: () => Promise<unknown>, opts?: EnqueueOpts): QueueTaskView {
    const id = opts?.taskId ?? `wq-${String(++this.seq).padStart(4, "0")}`
    if (this.index.has(id)) throw new Error(`QUEUE_TASK_ID_CONFLICT: 任务 id 重复 ${id}`)
    const entry: QueueEntry = {
      id,
      opKind,
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
      state: "queued",
      fn,
      queuedAt: this.now().toISOString(),
    }
    this.entries.push(entry)
    this.index.set(id, entry)
    this.evict()
    setImmediate(() => { void this.pump() })
    return this.toView(entry)
  }

  get(id: string): QueueTaskView | undefined {
    const e = this.index.get(id)
    return e ? this.toView(e) : undefined
  }

  /** 快照（登记顺序 = FIFO 执行顺序，含终态史；UI 轮询消费）。 */
  list(): QueueTaskView[] {
    return this.entries.map(e => this.toView(e))
  }

  depth(): number {
    let n = 0
    for (const e of this.entries) if (e.state === "queued" || e.state === "running") n++
    return n
  }

  private pump(): void {
    if (this.running) return
    const next = this.entries.find(e => e.state === "queued")
    if (!next) return
    this.running = true
    next.state = "running"
    next.startedAt = this.now().toISOString()
    void (async () => {
      let release: (() => void) | null = null
      try {
        if (this.lock) release = await this.lock.acquire({ opKind: next.opKind, taskId: next.id })
        await next.fn()
        next.state = "committed"
      } catch (err) {
        next.state = "failed"
        next.error = extractError(err)
        process.stderr.write(`[compile-queue] ${next.id} (${next.opKind}) failed: ${err instanceof Error ? err.message : String(err)}\n`)
      } finally {
        if (release) {
          try {
            release()
          } catch (err) {
            process.stderr.write(`[compile-queue] ${next.id} 锁释放异常（忽略）: ${err instanceof Error ? err.message : String(err)}\n`)
          }
        }
        next.finishedAt = this.now().toISOString()
        this.running = false
        this.pump()
      }
    })()
  }

  private toView(e: QueueEntry): QueueTaskView {
    let position: number | null = null
    if (e.state === "queued") {
      let rank = 0
      for (const q of this.entries) {
        if (q.state !== "queued") continue
        rank++
        if (q === e) break
      }
      position = rank
    }
    return {
      id: e.id,
      opKind: e.opKind,
      ...(e.label !== undefined ? { label: e.label } : {}),
      state: e.state,
      position,
      queuedAt: e.queuedAt,
      ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
      ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    }
  }

  private evict(): void {
    while (this.entries.length > this.capacity) {
      const idx = this.entries.findIndex(e => TERMINAL_STATES.includes(e.state))
      if (idx === -1) return // 全在跑/排队——超容量也无处可逐
      const [gone] = this.entries.splice(idx, 1)
      this.index.delete(gone.id)
    }
  }
}
