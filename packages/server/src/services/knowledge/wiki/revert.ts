import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG, resolveKnowledgeRoot } from "../global-paths"
import { CompileQueue, type WriteQueue } from "./compile-queue"
import {
  scanWikiEntries,
  renderBudgetedWikiIndex,
  WIKI_INDEX_FILE,
  WIKI_LOG_FILE,
  WIKI_LOG_HEADER,
  formatLogRow,
} from "./compile"
import { parseWikiFile, pageEntryView, caseEntryView, pageTypeOf } from "./format"
import { spawnGit, mustGit, wikiHead, type GitRunner } from "./wiki-git"
import { today } from "./util"

/**
 * 回滚服务 — 知识中心票12 AC5（spec §知识中心 UI「回滚」、原型 Tab④ 交互纪律③）。
 *
 * 语义：`git revert 单 commit` + 四同步（页文件回退 / INDEX 程序化重建 / LOG 追加
 * `## [date] revert | compile <short>` 行 / DB+FTS 与盘一致）。一切回滚经票06 全局
 * FIFO 队列 `opKind="revert"` 串行执行（旁路写 wiki = 违规）；跨进程锁占用在执行段
 * 显形为任务级 failed（LOCK_HELD），编译冲突同理（REVERT_CONFLICT，git revert --abort
 * 还原工作区，不留半成品）。
 *
 * registry 形态与 CuratorTaskService 同律（进程内 Map，超容量逐出终态；真相面 =
 * git revert commit 本身 + LOG 行）。raw/ 零触碰（不可变源不参与回滚）。
 */

export interface RevertTouchedFile {
  /** wiki 根相对路径（INDEX.md/LOG.md 不进页清单） */
  path: string
  /** removed=回退删除的页 · readded=回退恢复的页（原 commit 删过）· restored=内容回退 */
  action: "removed" | "readded" | "restored"
}

export interface WikiRevertResult {
  /** 回滚目标全 hash */
  target: string
  /** 新生成的 revert commit 全 hash（单 commit：含页回退+INDEX 重建+LOG 行） */
  revertCommit: string
  touched: RevertTouchedFile[]
  /** FTS 同步非致命失败时的告警（与编译通道 gotcha #6 同律：坏 FTS 不阻塞 commit） */
  ftsWarnings: string[]
}

export type RevertTaskStatus = "queued" | "running" | "committed" | "failed"

export interface RevertTaskRecord {
  id: string
  /** 回滚目标 commit（校验后的全 hash） */
  commit: string
  status: RevertTaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  result?: WikiRevertResult
  error?: { code: string; message: string }
}

export class RevertError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "RevertError"
  }
}

const COMMIT_RE = /^[0-9a-fA-F]{7,40}$/
const TERMINAL: RevertTaskStatus[] = ["committed", "failed"]

export interface RevertTaskDeps {
  db: Database.Database
  /** 知识根（缺省 resolveKnowledgeRoot()；wiki 根 = root/wiki） */
  root?: string
  git?: GitRunner
  now?: () => Date
  capacity?: number
  /** 全局写串行队列（票06）。缺省=服务私有 FIFO；生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
}

export class RevertTaskService {
  private readonly records = new Map<string, RevertTaskRecord>()
  private seq = 0
  private readonly db: Database.Database
  private readonly root: string
  private readonly wikiRoot: string
  private readonly git: GitRunner
  private readonly now: () => Date
  private readonly capacity: number
  private readonly queue: WriteQueue

  constructor(deps: RevertTaskDeps) {
    this.db = deps.db
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.git = deps.git ?? spawnGit(this.wikiRoot)
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
    this.queue = deps.queue ?? new CompileQueue()
  }

  /**
   * 任务视图读。执行体（队列 fn）正常路径自写终态；**fn 没起跑就失败**的形态
   * （跨进程锁占用 ⇒ 队列执行段 acquire 即拒）只落队列视图——这里做读时对账，
   * 把未终态记录与队列 failed 收敛（GET /queue/task/:id 与 GET /revert/task/:id
   * 两面对 UI 恒一致；票05 registry 同款缺口在本服务侧封上，UI 票12 依赖此保证）。
   */
  get(id: string): RevertTaskRecord | undefined {
    const rec = this.records.get(id)
    if (!rec) return undefined
    if (rec.status === "queued" || rec.status === "running") {
      const q = this.queue.get(id)
      if (q?.state === "failed") {
        rec.status = "failed"
        rec.error = q.error ?? { code: "QUEUE_OP_FAILED", message: "队列任务失败（无错误详情）" }
        rec.startedAt = q.startedAt
        rec.finishedAt = q.finishedAt ?? this.now().toISOString()
      } else if (q?.state === "queued" && rec.status === "queued") {
        // 位次不复制进 registry（UI 直查队列 API——单一位次真相源在票06）
      }
    }
    return rec
  }

  list(): RevertTaskRecord[] {
    return [...this.records.values()].reverse()
  }

  /**
   * 回滚入口：同步校验（commit 形制 + 在仓可解析）→ 建任务 → **入全局队列**，
   * 立即返回 queued 回执。校验失败直接抛 RevertError（路由映射 400/404，不建任务）。
   */
  revert(commit: string): RevertTaskRecord {
    const clean = commit.trim()
    if (!COMMIT_RE.test(clean)) {
      throw new RevertError("INVALID_PARAM", `commit 须为 7-40 位十六进制 hash：${commit}`, 400)
    }
    if (!fs.existsSync(path.join(this.wikiRoot, ".git"))) {
      throw new RevertError("NOT_FOUND", `wiki git 仓未初始化：${this.wikiRoot}`, 404)
    }
    const resolved = this.git.run(["rev-parse", "--verify", `${clean}^{commit}`])
    if (resolved.status !== 0) {
      throw new RevertError("NOT_FOUND", `目标 commit 不在 wiki 仓：${clean}`, 404)
    }
    const target = resolved.stdout.trim()

    const id = `rvt-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: RevertTaskRecord = { id, commit: target, status: "queued", createdAt: this.now().toISOString() }
    this.records.set(id, rec)
    this.evict()

    this.queue.enqueue("revert", async () => {
      await this.start(id)
      const done = this.records.get(id)
      if (done?.status === "failed") {
        const code = done.error?.code ?? "REVERT_FAILED"
        throw Object.assign(new Error(`${code}: ${done.error?.message ?? "回滚失败"}`), { code })
      }
    }, { taskId: id, label: target.slice(0, 9) })
    return rec
  }

  private async start(id: string): Promise<void> {
    const rec = this.records.get(id)
    if (!rec || rec.status !== "queued") return
    rec.status = "running"
    rec.startedAt = this.now().toISOString()
    try {
      rec.result = this.execute(rec.commit)
      rec.status = "committed"
    } catch (err) {
      const code = err instanceof RevertError ? err.code : "REVERT_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      rec.error = { code, message: message.replace(new RegExp(`^${code}: `), "") }
      rec.status = "failed"
      process.stderr.write(`[wiki-revert-task] ${id} failed: ${message}\n`)
    } finally {
      rec.finishedAt = this.now().toISOString()
    }
  }

  /**
   * 队列执行体（已持串行位）：git revert --no-commit → 触及清单 → INDEX 重建 →
   * LOG revert 行 → DB/FTS 逐页重同步 → 单 commit 收口。失败路径先把 revert
   * 状态机 abort 回 HEAD（工作区干净），再抛。
   */
  private execute(target: string): WikiRevertResult {
    const dirty = this.git.run(["status", "--porcelain"])
    if (dirty.stdout.trim().length > 0) {
      throw new RevertError("WORKTREE_DIRTY", "wiki 工作区存在未提交改动（不应发生：写闸全提交），拒绝回滚", 409)
    }

    const revertRun = this.git.run(["revert", "--no-commit", target])
    if (revertRun.status !== 0) {
      // 冲突（典型：目标 commit 之后又有提交改同页）→ 回退到干净 HEAD，不留半成品
      const abort = this.git.run(["revert", "--abort"])
      if (abort.status !== 0) this.git.run(["reset", "--hard", "HEAD"])
      throw new RevertError("REVERT_CONFLICT", `git revert 冲突（后续提交与回退互斥）：${target.slice(0, 9)} — ${revertRun.stderr.trim().split("\n").slice(-1)[0] ?? ""}`, 409)
    }

    // 触及清单（staged 反向 diff）：INDEX/LOG 是程序化文件，不进页清单
    const nameStatus = this.git.run(["diff", "--cached", "--name-status"]).stdout
    const touched: RevertTouchedFile[] = []
    for (const line of nameStatus.split("\n")) {
      const parts = line.trim().split("\t")
      if (parts.length < 2) continue
      const code = parts[0][0]
      // R/C 行 = flag<TAB>旧<TAB>新：取末段（新路径）
      const relPath = parts[parts.length - 1]
      if (relPath === WIKI_INDEX_FILE || relPath === WIKI_LOG_FILE) continue
      touched.push({
        path: relPath,
        action: code === "D" ? "removed" : code === "A" ? "readded" : "restored",
      })
    }

    const articles = new WikiArticleDAO(this.db)
    const ftsWarnings: string[] = []
    try {
      // ── INDEX 程序化重建（永不经人手，spec §三层架构；回退后按盘现形）──
      const indexPath = path.join(this.wikiRoot, WIKI_INDEX_FILE)
      if (fs.existsSync(this.wikiRoot)) {
        const entries = scanWikiEntries(this.wikiRoot)
        writeAtomic(indexPath, renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content)
      }

      // ── LOG 追加 revert 行（票11 读面行格式契约：`## [date] revert | compile <short>`）──
      const logPath = path.join(this.wikiRoot, WIKI_LOG_FILE)
      const logBase = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
      writeAtomic(logPath, logBase + formatLogRow({
        action: "revert",
        entry: `compile ${target.slice(0, 7)}`,
        note: "回滚本次编译",
        source: "git revert",
        reviewer: "owner",
      }))

      // ── DB/FTS 逐页重同步：在盘 ⇒ upsert+FTS 重写；不在盘 ⇒ 行+FTS 删除 ──
      for (const t of touched) {
        const abs = path.join(this.wikiRoot, t.path)
        if (fs.existsSync(abs)) {
          const row = entryRowFromDisk(abs, t.path)
          if (!row) continue
          articles.upsert(row)
          const rowid = articles.getRowid(GLOBAL_WIKI_ORG, row.id)
          if (rowid !== undefined) {
            try {
              articles.deleteFts(rowid)
              articles.insertFts({
                rowid,
                id: row.id,
                domain: row.domain,
                title: row.title,
                summary: row.summary,
                topics: row.topics,
                body: row.body,
              })
            } catch (err) {
              ftsWarnings.push(`FTS 同步失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        } else {
          const found = this.db
            .prepare("SELECT id FROM wiki_articles WHERE org = ? AND path = ?")
            .get(GLOBAL_WIKI_ORG, t.path) as { id: string } | undefined
          if (found) {
            const rowid = articles.getRowid(GLOBAL_WIKI_ORG, found.id)
            if (rowid !== undefined) {
              try { articles.deleteFts(rowid) } catch (err) {
                ftsWarnings.push(`FTS 删除失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
              }
            }
            articles.delete(GLOBAL_WIKI_ORG, found.id)
          }
        }
      }

      // ── 单 commit 收口（add -A 把页回退+INDEX+LOG 一并带上；锁文件已 exclude）──
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length === 0) {
        // 理论上不可能（LOG 行必产生 diff）；兜底不抛，回滚语义 = no-op
        return { target, revertCommit: wikiHead(this.git) ?? target, touched, ftsWarnings }
      }
      mustGit(this.git, ["commit", "-m", `revert: ${target.slice(0, 7)} — 回滚本次编译`])
      const revertCommit = wikiHead(this.git)
      if (!revertCommit) throw new RevertError("REVERT_FAILED", "revert commit 后 HEAD 不可读", 500)
      return { target, revertCommit, touched, ftsWarnings }
    } catch (err) {
      // 执行体自身异常（非 git 冲突路径）：尽力清 revert 状态，工作区回正
      const abort = this.git.run(["revert", "--abort"])
      if (abort.status !== 0) {
        this.git.run(["reset", "--hard", "HEAD"])
      }
      throw err
    }
  }

  private evict(): void {
    if (this.records.size <= this.capacity) return
    for (const [id, rec] of this.records) {
      if (TERMINAL.includes(rec.status)) {
        this.records.delete(id)
        if (this.records.size <= this.capacity) return
      }
    }
  }
}

/** tmp+rename 原子替换（compile 通道同款语义；本地实现因 compile 未导出）。 */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, "utf-8")
  fs.renameSync(tmp, target)
}

/** wiki_articles upsert 行形（DAO 的 Omit<..., "updated_at"> 同形）。 */
type ArticleUpsertRow = Parameters<WikiArticleDAO["upsert"]>[0]

/**
 * 盘文件 → DB 行（domain 存 v3 type 值，与编译通道 upsert 同形）。
 * 解析失败（坏 front-matter）不炸回滚：跳过该页并留 stderr（回滚的 git/fs 面
 * 已成立，坏页由后续编译/lint 通道处理）。
 */
function entryRowFromDisk(abs: string, relPath: string): ArticleUpsertRow | null {
  try {
    const parsed = parseWikiFile(fs.readFileSync(abs, "utf-8"))
    const meta = parsed.kind === "page" ? pageEntryView(parsed.meta) : parsed.kind === "case" ? caseEntryView(parsed.meta, today()) : parsed.meta
    const domain = parsed.kind === "case" ? "case" : pageTypeOf(parsed.kind === "page" ? parsed.meta : meta)
    return {
      org: GLOBAL_WIKI_ORG,
      id: meta.id,
      domain,
      title: meta.title,
      summary: meta.summary,
      topics: JSON.stringify(meta.topics),
      stability: meta.stability ?? "stable",
      last_compiled: meta.last_compiled,
      sources: JSON.stringify(meta.sources),
      confidence: meta.confidence ?? 0.5,
      body: parsed.body,
      path: relPath,
    }
  } catch (err) {
    process.stderr.write(`[wiki-revert] 页重同步解析跳过 ${relPath}: ${err instanceof Error ? err.message : String(err)}\n`)
    return null
  }
}
