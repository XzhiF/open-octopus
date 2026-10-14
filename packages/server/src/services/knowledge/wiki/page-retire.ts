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
import { parseWikiFile, serializePageMarkdown } from "./format"
import { spawnGit, mustGit, wikiHead, type GitRunner } from "./wiki-git"
import { isManualFileTarget } from "./manual-files"

/**
 * 页退役服务 — 票08 清理账（spec 故事32：E2E 沉淀页经策展对话退役入 `_retired/`）。
 *
 * 语义：把一册 v3 页（entities/concepts/topics/sources）**迁 `_retired/<原相对路径>`**
 * + front-matter 注 `status: superseded` + INDEX 程序化重建摘除 + LOG 追加
 * `## [date] retire | <path>` 行 + wiki_articles/FTS 摘除同步（照 revert 的四路摘除同型）。
 * 一切退役经票06 全局 FIFO 队列 `opKind="page-retire"` 串行执行（旁路写 wiki = 违规）；
 * 单 commit 收口（页迁 + INDEX + LOG 一并带上），失败不留半成品。
 *
 * 写保护继承：user_preference.md / SCHEMA.md 经 `isManualFileTarget` 拒退（唯一写闸
 * manual-file 面）；case 域走判例管线自带 status，本服务只收 **page** 形态。
 *
 * registry 形态与 RevertTaskService/CuratorTaskService 同律（进程内 Map，超容量逐出终态；
 * 真相面 = git commit 本身 + LOG 行）。raw/ 零触碰（不可变源不参与退役）。
 */

export interface PageRetireTouched {
  /** 原 wiki 根相对路径（退役前位置） */
  from: string
  /** 迁入的 `_retired/` 相对路径 */
  to: string
}

export interface WikiRetireResult {
  /** 退役页原相对路径 */
  path: string
  /** 迁入后的 `_retired/` 相对路径 */
  retiredPath: string
  /** 退役 commit 全 hash（单 commit：含页迁+INDEX 重建+LOG 行） */
  retireCommit: string
  /** front-matter 注 superseded + 页 id */
  pageId: string
  touched: PageRetireTouched
  ftsWarnings: string[]
}

export type PageRetireTaskStatus = "queued" | "running" | "committed" | "failed"

export interface PageRetireTaskRecord {
  id: string
  path: string
  reason?: string
  status: PageRetireTaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  result?: WikiRetireResult
  error?: { code: string; message: string }
}

export class PageRetireError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "PageRetireError"
  }
}

const TERMINAL: PageRetireTaskStatus[] = ["committed", "failed"]
/** 仅这四类 v3 页目录可页退役（cases 走判例管线；_retired/ 已是退役区）。 */
const RETIRABLE_DIR_RE = /^(entities|concepts|topics|sources)\/[^/]+\.md$/

export interface PageRetireInput {
  /** wiki 根相对路径，如 `entities/ent-kc15-widget-a.md`（与 pageId 二选一） */
  path?: string
  /** front-matter id（与 path 二选一；经 scan 定位其相对路径） */
  pageId?: string
  /** 退役理由（进 LOG 行 + 回执卡，非必填） */
  reason?: string
}

export interface PageRetireTaskDeps {
  db: Database.Database
  /** 知识根（缺省 resolveKnowledgeRoot()；wiki 根 = root/wiki） */
  root?: string
  git?: GitRunner
  now?: () => Date
  capacity?: number
  /** 全局写串行队列（票06）。生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
}

export class PageRetireTaskService {
  private readonly records = new Map<string, PageRetireTaskRecord>()
  private seq = 0
  private readonly db: Database.Database
  private readonly root: string
  private readonly wikiRoot: string
  private readonly git: GitRunner
  private readonly now: () => Date
  private readonly capacity: number
  private readonly queue: WriteQueue

  constructor(deps: PageRetireTaskDeps) {
    this.db = deps.db
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.git = deps.git ?? spawnGit(this.wikiRoot)
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
    this.queue = deps.queue ?? new CompileQueue()
  }

  /** 读时对账（同 RevertTaskService）：fn 未起跑即失败（锁占用）只落队列视图 → 收敛。 */
  get(id: string): PageRetireTaskRecord | undefined {
    const rec = this.records.get(id)
    if (!rec) return undefined
    if (rec.status === "queued" || rec.status === "running") {
      const q = this.queue.get(id)
      if (q?.state === "failed") {
        rec.status = "failed"
        rec.error = q.error ?? { code: "QUEUE_OP_FAILED", message: "队列任务失败（无错误详情）" }
        rec.startedAt = q.startedAt
        rec.finishedAt = q.finishedAt ?? this.now().toISOString()
      }
    }
    return rec
  }

  list(): PageRetireTaskRecord[] {
    return [...this.records.values()].reverse()
  }

  /**
   * 退役入口：同步校验（定位在册页 + 非人工文件 + 在盘）→ 建任务 → **入全局队列**，
   * 立即返回 queued 回执。校验失败直接抛 PageRetireError（路由映射 400/403/404，不建任务）。
   */
  retire(input: PageRetireInput): PageRetireTaskRecord {
    const relPath = this.resolveRelPath(input)
    if (!relPath) {
      throw new PageRetireError("INVALID_PARAM", "须提供 path（v3 页相对路径）或可定位的 pageId", 400)
    }
    if (!RETIRABLE_DIR_RE.test(relPath)) {
      throw new PageRetireError(
        "INVALID_PARAM",
        `仅 entities/concepts/topics/sources 下的 .md 页可页退役（cases 走判例管线）：${relPath}`,
        400,
      )
    }
    const abs = path.resolve(this.wikiRoot, relPath)
    // 路径逃逸闸：归一后必须仍在 wiki 根内
    if (!abs.startsWith(this.wikiRoot + path.sep)) {
      throw new PageRetireError("INVALID_PARAM", `路径越界（须落在 wiki 根内）：${relPath}`, 400)
    }
    // 写保护继承：user_preference.md / SCHEMA.md 拒退
    if (isManualFileTarget(this.wikiRoot, abs)) {
      throw new PageRetireError("MANUAL_FILE_WRITE", `人工文件不可经唯一写闸退役：${path.basename(abs)}`, 409)
    }
    if (!fs.existsSync(abs)) {
      throw new PageRetireError("NOT_FOUND", `在册页不存在：${relPath}`, 404)
    }
    if (!fs.existsSync(path.join(this.wikiRoot, ".git"))) {
      throw new PageRetireError("NOT_FOUND", `wiki git 仓未初始化：${this.wikiRoot}`, 404)
    }

    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined
    const id = `ret-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: PageRetireTaskRecord = { id, path: relPath, reason, status: "queued", createdAt: this.now().toISOString() }
    this.records.set(id, rec)
    this.evict()

    this.queue.enqueue("page-retire", async () => {
      await this.start(id)
      const done = this.records.get(id)
      if (done?.status === "failed") {
        const code = done.error?.code ?? "PAGE_RETIRE_FAILED"
        throw Object.assign(new Error(`${code}: ${done.error?.message ?? "页退役失败"}`), { code })
      }
    }, { taskId: id, label: relPath })
    return rec
  }

  /** path 优先；否则经 scanWikiEntries 用 pageId 定位在册页相对路径（执行段再复检形态）。 */
  private resolveRelPath(input: PageRetireInput): string | null {
    if (typeof input.path === "string" && input.path.trim()) {
      return input.path.trim().replace(/^\.\//, "")
    }
    if (typeof input.pageId === "string" && input.pageId.trim()) {
      const pid = input.pageId.trim()
      // ScannedEntry.meta.id 是各形态统一视图 id（page/entry/case 都有）；
      // 非页形态（cases/旧词条）的 relPath 随后被 RETIRABLE_DIR_RE 拒。
      for (const e of scanWikiEntries(this.wikiRoot)) {
        if (e.meta.id === pid) return e.relPath
      }
      return null
    }
    return null
  }

  private async start(id: string): Promise<void> {
    const rec = this.records.get(id)
    if (!rec || rec.status !== "queued") return
    rec.status = "running"
    rec.startedAt = this.now().toISOString()
    try {
      rec.result = this.execute(rec.path, rec.reason)
      rec.status = "committed"
    } catch (err) {
      const code = err instanceof PageRetireError ? err.code : "PAGE_RETIRE_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      rec.error = { code, message: message.replace(new RegExp(`^${code}: `), "") }
      rec.status = "failed"
      process.stderr.write(`[wiki-page-retire] ${id} failed: ${message}\n`)
    } finally {
      rec.finishedAt = this.now().toISOString()
    }
  }

  /**
   * 队列执行体（已持串行位）：读页注 superseded → 迁 `_retired/` → INDEX 重建 →
   * LOG retire 行 → DB/FTS 摘除 → 单 commit。任一步异常尽力回滚已迁文件（保工作区一致），再抛。
   */
  private execute(relPath: string, reason?: string): WikiRetireResult {
    const dirty = this.git.run(["status", "--porcelain"])
    if (dirty.stdout.trim().length > 0) {
      throw new PageRetireError("WORKTREE_DIRTY", "wiki 工作区存在未提交改动（不应发生：写闸全提交），拒绝退役", 409)
    }

    const fromAbs = path.resolve(this.wikiRoot, relPath)
    if (!fs.existsSync(fromAbs)) {
      throw new PageRetireError("NOT_FOUND", `在册页不存在（执行段复检）：${relPath}`, 404)
    }

    // ── 1. 读页 + 注 superseded（仅 page 形态）──
    const parsed = parseWikiFile(fs.readFileSync(fromAbs, "utf-8"))
    if (parsed.kind !== "page") {
      throw new PageRetireError(
        "NOT_A_PAGE",
        `仅 v3 页可页退役（判例走 compileCase status，词条走重蒸馏）：${relPath} kind=${parsed.kind}`,
        409,
      )
    }
    const meta = { ...parsed.meta, status: "superseded" as const }
    const retiredSerialized = serializePageMarkdown(meta, parsed.body)

    // ── 2. 迁 `_retired/<relPath>`（先写新位，再删原位；同盘 rename 语义由写+删等价达成，
    //        保留内容含 superseded，绝不丢页——红线「归档先于删除」的页级映射）──
    const toRel = `_retired/${relPath}`
    const toAbs = path.resolve(this.wikiRoot, toRel)
    if (!toAbs.startsWith(this.wikiRoot + path.sep)) {
      throw new PageRetireError("INVALID_PARAM", `退役目标越界：${toRel}`, 400)
    }
    fs.mkdirSync(path.dirname(toAbs), { recursive: true })
    writeAtomic(toAbs, retiredSerialized)
    fs.unlinkSync(fromAbs)

    const ftsWarnings: string[] = []
    try {
      // ── 3. INDEX 程序化重建（永不经人手；_retired/ 不在 scan 面 ⇒ 页自动摘除）──
      const indexPath = path.join(this.wikiRoot, WIKI_INDEX_FILE)
      const entries = scanWikiEntries(this.wikiRoot)
      writeAtomic(indexPath, renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content)

      // ── 4. LOG 追加 retire 行 ──
      const logPath = path.join(this.wikiRoot, WIKI_LOG_FILE)
      const logBase = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
      writeAtomic(logPath, logBase + formatLogRow({
        action: "retire",
        entry: relPath,
        note: reason ? `退役入 _retired/ · ${reason}` : "退役入 _retired/",
        source: "dialogue",
        reviewer: "owner",
      }))

      // ── 5. DB/FTS 摘除（按原 path 定位行；在 _retired/ 的页不进索引面）──
      const articles = new WikiArticleDAO(this.db)
      const found = this.db
        .prepare("SELECT id FROM wiki_articles WHERE org = ? AND path = ?")
        .get(GLOBAL_WIKI_ORG, relPath) as { id: string } | undefined
      if (found) {
        const rowid = articles.getRowid(GLOBAL_WIKI_ORG, found.id)
        if (rowid !== undefined) {
          try { articles.deleteFts(rowid) } catch (err) {
            ftsWarnings.push(`FTS 删除失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        articles.delete(GLOBAL_WIKI_ORG, found.id)
      }

      // ── 6. 单 commit 收口（add -A 把页迁+INDEX+LOG 一并带上）──
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length === 0) {
        // 理论上 LOG 行必产生 diff；兜底 no-op 不抛
        return {
          path: relPath, retiredPath: toRel, retireCommit: wikiHead(this.git) ?? "", pageId: meta.id,
          touched: { from: relPath, to: toRel }, ftsWarnings,
        }
      }
      mustGit(this.git, ["commit", "-m", `retire: ${relPath} → _retired/（superseded）`])
      const retireCommit = wikiHead(this.git)
      if (!retireCommit) throw new PageRetireError("PAGE_RETIRE_FAILED", "退役 commit 后 HEAD 不可读", 500)
      return {
        path: relPath, retiredPath: toRel, retireCommit, pageId: meta.id,
        touched: { from: relPath, to: toRel }, ftsWarnings,
      }
    } catch (err) {
      // 尽力复原：若退役件已落 _retired/ 而原页已删，把内容写回原路径（工作区回正，不留半退役）
      try {
        if (!fs.existsSync(fromAbs) && fs.existsSync(toAbs)) {
          fs.mkdirSync(path.dirname(fromAbs), { recursive: true })
          fs.copyFileSync(toAbs, fromAbs)
          fs.rmSync(toAbs, { force: true })
        }
      } catch { /* 复原尽力而为 */ }
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

/** tmp+rename 原子替换（compile/revert 通道同款语义；本地实现因 compile 未导出）。 */
function writeAtomic(target: string, content: string): void {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, "utf-8")
  fs.renameSync(tmp, target)
}
