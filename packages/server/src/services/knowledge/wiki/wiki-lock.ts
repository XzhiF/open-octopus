import fs from "fs"
import path from "path"
import type { WriteLock, WriteOpKind } from "./compile-queue"

/**
 * WikiLock — wiki 根锁文件（跨进程保底）— 知识中心票06 第二级互斥。
 *
 * 定位（spec §全局写串行两级机制）：进程内 CompileQueue 已保证单例串行；本锁防的是
 * **同机双实例双写**（dev + prod 两个 server 进程各持一座队列，互不知晓）。锁落在
 * wiki 根（`.compile.lock`），持有者写 PID+心跳，写入者在跑任务前必须持锁。
 *
 * stale 判据（story 39「进程崩溃遗留的 stale 锁自动回收」，两条任一即 stale）：
 *   ① PID 不存在（`process.kill(pid, 0)` 探活）——崩溃直接判死；
 *   ② 心跳超时——进程存活但不再心跳（被 SIGSTOP/容器冻结等）同样可回收。
 * 读永不锁：浏览/检索/agent 查阅不读本文件、不受本模块任何约束（票面 AC4）。
 *
 * 已知边界：这是 O_EXCL 抢占式**建议锁**（防呆不防恶意）——reclaim 的 unlink→重创
 * 之间存在微秒级 TOCTOU 窗口，unlink 前二读确认收窄；跨进程完美互斥需 OS 级
 * advisory lock，spec 裁决的粒度（保底闸 + 进程内主控）不需要那层成本。
 * 锁文件已加入 wiki 仓 `.git/info/exclude`（wiki-git.ts ensureWikiGitRepo），
 * 编译的 `git add -A` 不会把它带进 commit。
 */

export const WIKI_LOCK_FILE = ".compile.lock"

/**
 * 心跳重写间隔。锁存续期间每 2s 刷一次 heartbeatAt——远小于 stale 阈值，
 * 正常持锁永不被误抢；setInterval.unref()，不拖测试/进程退出。
 */
export const WIKI_LOCK_HEARTBEAT_INTERVAL_MS = 2_000

/**
 * stale 判据②阈值 = 60s。理由：wiki 编译内嵌 spawnGit（默认 timeout 30_000ms）**同步**
 * 调用——git 卡住会冻结整个事件循环，心跳同样停摆；60s = 容忍连续两次满额 30s git
 * 超时仍不误判活锁；同时崩溃残留最迟 60s+poll 即可回收，串行不因一次崩溃永久卡死。
 */
export const WIKI_LOCK_STALE_AFTER_MS = 60_000

/**
 * 抢锁等待上限 = 5min。理由：另一实例跑一次正常编译（真 provider E2E 实测长例 169s）
 * 期间，本实例任务应**排队等待**而非秒败；超 5min 仍被占 ⇒ 视异常占用，LOCK_HELD
 * 报错走失败语义（任务 failed、队列继续），不无限堆等待。
 */
export const WIKI_LOCK_WAIT_MS = 300_000

/** 抢锁轮询间隔。 */
export const WIKI_LOCK_POLL_MS = 250

export interface WikiLockPayload {
  pid: number
  opKind: WriteOpKind | string
  taskId: string
  /** epoch ms */
  acquiredAt: number
  /** epoch ms——持有者持续刷新；判 stale 用 */
  heartbeatAt: number
}

export class WikiLockError extends Error {
  constructor(readonly code: "LOCK_HELD" | "LOCK_READ_FAILED", message: string) {
    super(`${code}: ${message}`)
    this.name = "WikiLockError"
  }
}

export interface WikiLockDeps {
  /** 惰性解析 wiki 根（env/注入 tmpdir；每次 acquire 现读——编译首跑前 wiki 根可能尚不存在） */
  wikiRoot: () => string
  now?: () => number
  /** 假 PID 注入点——双实例模拟测试（票面 AC3） */
  pid?: () => number
  /** 探活 seam（测试注入） */
  isPidAlive?: (pid: number) => boolean
  heartbeatIntervalMs?: number
  staleAfterMs?: number
  /** 等待上限；0 = 不等（fail-fast） */
  waitMs?: number
  pollMs?: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** POSIX/Windows 通吃探活：signal 0 只查存在性；EPERM（存在但无权限）算活。 */
export function isPidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export class WikiLock implements WriteLock {
  private readonly wikiRoot: () => string
  private readonly now: () => number
  private readonly pid: () => number
  private readonly alive: (pid: number) => boolean
  private readonly heartbeatIntervalMs: number
  private readonly staleAfterMs: number
  private readonly waitMs: number
  private readonly pollMs: number

  constructor(deps: WikiLockDeps) {
    this.wikiRoot = deps.wikiRoot
    this.now = deps.now ?? (() => Date.now())
    this.pid = deps.pid ?? (() => process.pid)
    this.alive = deps.isPidAlive ?? isPidAliveDefault
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? WIKI_LOCK_HEARTBEAT_INTERVAL_MS
    this.staleAfterMs = deps.staleAfterMs ?? WIKI_LOCK_STALE_AFTER_MS
    this.waitMs = deps.waitMs ?? WIKI_LOCK_WAIT_MS
    this.pollMs = deps.pollMs ?? WIKI_LOCK_POLL_MS
  }

  /** 当前 wiki 根锁文件路径（只读诊断用；测试断言辅助）。 */
  lockPath(): string {
    return path.join(this.wikiRoot(), WIKI_LOCK_FILE)
  }

  /**
   * 抢锁：O_EXCL 独占创建 → 失败读现有 → stale 回收（unlink 前二读确认）→ 重试，
   * 至 waitMs 超时抛 LOCK_HELD。成功返回 release()（清心跳 + 仅删自己的锁）。
   */
  async acquire(meta: { opKind: WriteOpKind; taskId: string }): Promise<() => void> {
    const root = this.wikiRoot()
    const lockPath = path.join(root, WIKI_LOCK_FILE)
    fs.mkdirSync(root, { recursive: true })
    const deadline = this.now() + this.waitMs

    for (;;) {
      const mine: WikiLockPayload = {
        pid: this.pid(),
        opKind: meta.opKind,
        taskId: meta.taskId,
        acquiredAt: this.now(),
        heartbeatAt: this.now(),
      }
      const created = this.tryCreate(lockPath, mine)
      if (created) {
        // 写后验：极端场景（我方创建被并行回收者 unlink+抢占）内容已易主 ⇒ 让位重排队
        const back = this.readPayload(lockPath)
        if (back && back.taskId === mine.taskId && back.pid === mine.pid) {
          return this.hold(lockPath, mine)
        }
      } else if (this.isStaleOnDisk(lockPath)) {
        // unlink 前二读确认仍 stale，收窄「对方刚回收并持活锁」的 TOCTOU 窗口
        if (this.isStaleOnDisk(lockPath)) {
          try {
            fs.unlinkSync(lockPath)
          } catch { /* 已被他人清理——下一轮自然重走 tryCreate */ }
          continue
        }
      }

      if (this.now() >= deadline) {
        const cur = this.readPayload(lockPath)
        throw new WikiLockError(
          "LOCK_HELD",
          `wiki 根锁被其他进程持有（pid=${cur?.pid ?? "?"} task=${cur?.taskId ?? "?"}），等待 ${this.waitMs}ms 超时`,
        )
      }
      await sleep(this.pollMs)
    }
  }

  private tryCreate(lockPath: string, payload: WikiLockPayload): boolean {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx" })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
      throw err
    }
  }

  /** stale 判定对「解析成功/损坏」两形态统一：损坏文件按 mtime 论心跳。 */
  private isStaleOnDisk(lockPath: string): boolean {
    const cur = this.readPayload(lockPath)
    if (cur) return !this.alive(cur.pid) || this.now() - cur.heartbeatAt >= this.staleAfterMs
    try {
      const st = fs.statSync(lockPath)
      return this.now() - st.mtimeMs >= this.staleAfterMs
    } catch {
      return false
    }
  }

  private readPayload(lockPath: string): WikiLockPayload | null {
    let text: string
    try {
      text = fs.readFileSync(lockPath, "utf-8")
    } catch {
      return null
    }
    try {
      const p = JSON.parse(text) as Partial<WikiLockPayload>
      if (typeof p.pid !== "number" || typeof p.taskId !== "string" || typeof p.heartbeatAt !== "number") return null
      return p as WikiLockPayload
    } catch {
      return null
    }
  }

  /** 心跳保活 + release（只删仍属于自己的锁文件）。 */
  private hold(lockPath: string, mine: WikiLockPayload): () => void {
    const timer = setInterval(() => {
      try {
        fs.writeFileSync(lockPath, JSON.stringify({ ...mine, heartbeatAt: this.now() }))
      } catch { /* 锁已被夺（stale 误判边缘窗）——best-effort，不炸编译 */ }
    }, this.heartbeatIntervalMs)
    timer.unref?.()
    let released = false
    return () => {
      if (released) return
      released = true
      clearInterval(timer)
      try {
        const cur = this.readPayload(lockPath)
        if (!cur || (cur.pid === mine.pid && cur.taskId === mine.taskId)) fs.unlinkSync(lockPath)
      } catch { /* 已不在盘，视为已释放 */ }
    }
  }
}
