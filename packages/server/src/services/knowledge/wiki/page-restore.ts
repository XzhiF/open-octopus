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
  atomicWrite,
} from "./compile"
import { parseWikiFile, serializePageMarkdown, extractRuleAnchors, pageEntryView } from "./format"
import { spawnGit, mustGit, wikiHead, type GitRunner } from "./wiki-git"
import { isManualFileTarget } from "./manual-files"
import { RETIRABLE_DIR_RE } from "./page-retire"

/**
 * 页恢复服务 — 票09·spec 故事 17：自动退役可恢复（对话「恢复 oct-XXX」→ 从 _retired/
 * 迁回 + 入链回补），窄口误伤的后悔药。
 *
 * 语义（与票04 退役机械成对，方向相反）：
 * - **原号原行**：退役页整册回迁原相对路径，锚点 `<!--#oct-NNN-->` 随文件原样随迁——
 *   这是「锚点永不复用」纪律（compile.nextRuleAnchor 发号空间含 _retired 递归扫面，
 *   compile.ts:222-258/266-272）的**恢复豁免面**：回迁不重铸号，页回在册面后该号
 *   继续占发号空间（scan 面与 _retired 面交接无缝，历史 wiki_refs 永不撞新进号）。
 *   front-matter 剥退役装饰位（status: superseded / replaced_by），正文逐字留存。
 * - **入链回补 = retire 单 commit diff 反放**（票04 备案语义）：按 git 消息头
 *   `retire: <relPath> → _retired/（superseded）` 定位最近一次退役 commit（发现面=
 *   LOG retire 行同址可互证），对其触及的**宿主页**逐一处置：宿主现文 == 退役后态 ⇒
 *   写回退役前态（逐字节还原，宿主原链逐字在史）；已漂移/已不在册 ⇒ 让位并显形 warning
 *   （自动通道不吞后期编辑——红线2 保守方向，取舍归人）。
 * - 回迁是 wiki 写：经全局 FIFO 队列（红线1），opKind="page-restore"（审计面独立词，
 *   与 auto-retire/page-retire 三 kind 同族可 grep）。INDEX 重建 + LOG `restore` 行 +
 *   DB/FTS 复登（页 + 被回补宿主）+ 单 commit 收口；失败尽力回滚不留半恢复。
 *
 * 对话「退役一页」通道同款接线（routes/wiki-retire.ts → 本服务镜像 routes/wiki-restore.ts）。
 * registry 形态与 PageRetireTaskService/RevertTaskService 同律（进程内 Map；真相面=git）。
 */

export interface WikiRestoreResult {
  /** 回迁后的 wiki 根相对路径（= 退役前原位置） */
  path: string
  /** 迁出的 `_retired/<…>` 相对路径 */
  fromRetired: string
  /** 恢复 commit 全 hash（单 commit：页回迁+入链回补+INDEX+LOG+宿主页落盘） */
  restoreCommit: string
  pageId: string
  /** 逐字节还原了入链的宿主页数（wiki 根相对路径） */
  inboundRestored: string[]
  /** 诚实显形面（漂移让位/退役 commit 不可寻等），非致命 */
  warnings: string[]
  ftsWarnings: string[]
}

export type PageRestoreTaskStatus = "queued" | "running" | "committed" | "failed"

export interface PageRestoreTaskRecord {
  id: string
  path: string
  /** 对话口令（恢复 oct-XXX 的锚点），按锚定位时有值 */
  anchor?: string
  reason?: string
  /** LOG restore 行 source 位；缺省 "dialogue"（对话人裁回迁） */
  source?: string
  status: PageRestoreTaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  result?: WikiRestoreResult
  error?: { code: string; message: string }
}

export class PageRestoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "PageRestoreError"
  }
}

const TERMINAL: PageRestoreTaskStatus[] = ["committed", "failed"]

/** 退役执行体的 commit 消息头（发现面单源——改此词必须同步 page-retire.ts 的 commit 行）。 */
export function retireCommitSubject(relPath: string): string {
  return `retire: ${relPath} → _retired/（superseded）`
}

export interface PageRestoreInput {
  /** 对话口令「恢复 oct-XXX」：在 _retired/ 全扫正文锚点定位退役页（优先位） */
  anchor?: string
  /** 原相对路径（如 topics/top-zombie.md；与 anchor/pageId 择一） */
  path?: string
  /** front-matter id（与 anchor/path 择一） */
  pageId?: string
  reason?: string
  source?: string
}

export interface PageRestoreTaskDeps {
  db: Database.Database
  /** 知识根（缺省 resolveKnowledgeRoot()；wiki 根 = root/wiki） */
  root?: string
  git?: GitRunner
  now?: () => Date
  capacity?: number
  /** 全局写串行队列（票06）。生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
}

export class PageRestoreTaskService {
  private readonly records = new Map<string, PageRestoreTaskRecord>()
  private seq = 0
  private readonly db: Database.Database
  private readonly root: string
  private readonly wikiRoot: string
  private readonly git: GitRunner
  private readonly now: () => Date
  private readonly capacity: number
  private readonly queue: WriteQueue

  constructor(deps: PageRestoreTaskDeps) {
    this.db = deps.db
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.git = deps.git ?? spawnGit(this.wikiRoot)
    this.now = deps.now ?? (() => new Date())
    this.capacity = deps.capacity ?? 200
    this.queue = deps.queue ?? new CompileQueue()
  }

  /** 读时对账（PageRetireTaskService 同律）：fn 未起跑即失败（锁占用）只落队列视图 → 收敛。 */
  get(id: string): PageRestoreTaskRecord | undefined {
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

  list(): PageRestoreTaskRecord[] {
    return [...this.records.values()].reverse()
  }

  /**
   * 恢复入口：同步校验（_retired 定位 + 回迁位合法与空置 + 非人工文件 + 有 git）→
   * 建任务 → **入全局队列**（opKind="page-restore"），立即返回 queued 回执。
   * 校验失败抛 PageRestoreError（路由映射 400/404/409，不建任务——revert/retire 同律）。
   */
  restore(input: PageRestoreInput): PageRestoreTaskRecord {
    const found = this.resolveRetired(input)
    if (!found) {
      const subject = input.anchor?.trim() || input.pageId?.trim() || input.path?.trim() || "?"
      throw new PageRestoreError("RESTORE_TARGET_MISSING", `_retired/ 无此退役页（锚点/id/路径三种口令均未命中）：${subject}`, 404)
    }
    const { relPath } = found
    if (!RETIRABLE_DIR_RE.test(relPath)) {
      throw new PageRestoreError("INVALID_PARAM", `回迁目标不在可在册面（仅 entities/concepts/topics/sources 一层 .md）：${relPath}`, 400)
    }
    const liveAbs = path.resolve(this.wikiRoot, relPath)
    if (!liveAbs.startsWith(this.wikiRoot + path.sep)) {
      throw new PageRestoreError("INVALID_PARAM", `回迁路径越界：${relPath}`, 400)
    }
    if (isManualFileTarget(this.wikiRoot, liveAbs)) {
      throw new PageRestoreError("MANUAL_FILE_WRITE", `人工文件不可经唯一写闸回迁：${path.basename(liveAbs)}`, 409)
    }
    if (fs.existsSync(liveAbs)) {
      throw new PageRestoreError("RESTORE_TARGET_TAKEN", `原位在册已有页（不覆盖不并置，先处置现页再恢复）：${relPath}`, 409)
    }
    if (!fs.existsSync(path.join(this.wikiRoot, ".git"))) {
      throw new PageRestoreError("NOT_FOUND", `wiki git 仓未初始化：${this.wikiRoot}`, 404)
    }

    const anchor = typeof input.anchor === "string" && input.anchor.trim() ? input.anchor.trim() : undefined
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : undefined
    const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : undefined
    const id = `res-${this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)}-${String(++this.seq).padStart(3, "0")}`
    const rec: PageRestoreTaskRecord = { id, path: relPath, anchor, reason, source, status: "queued", createdAt: this.now().toISOString() }
    this.records.set(id, rec)
    this.evict()

    this.queue.enqueue("page-restore", async () => {
      await this.start(id)
      const done = this.records.get(id)
      if (done?.status === "failed") {
        const code = done.error?.code ?? "PAGE_RESTORE_FAILED"
        throw Object.assign(new Error(`${code}: ${done.error?.message ?? "页恢复失败"}`), { code })
      }
    }, { taskId: id, label: relPath })
    return rec
  }

  /**
   * 三种口令定位 `_retired/` 退役页：anchor（正文锚点全扫，对话「恢复 oct-XXX」主形态）
   * > path（`_retired/<path>` 直查）> pageId（front-matter id 对拍）。执行段复检。
   */
  private resolveRetired(input: PageRestoreInput): { relPath: string } | null {
    const anchor = typeof input.anchor === "string" ? input.anchor.trim() : ""
    const direct = typeof input.path === "string" ? input.path.trim().replace(/^\.\//, "") : ""
    const pid = typeof input.pageId === "string" ? input.pageId.trim() : ""
    if (direct) {
      const rel = `_retired/${direct}`
      if (fs.existsSync(path.resolve(this.wikiRoot, rel))) return { relPath: direct }
      return null
    }
    if (!anchor && !pid) return null
    for (const rel of this.listRetiredFiles()) {
      const relPath = rel.slice("_retired/".length)
      if (pid) {
        try {
          const parsed = parseWikiFile(fs.readFileSync(path.resolve(this.wikiRoot, rel), "utf-8"))
          if (parsed.kind === "page" && parsed.meta.id === pid) return { relPath }
        } catch { /* 坏文件跳过（scan 同律） */ }
      } else {
        // 锚点面：extractRuleAnchors 制式（与发号空间/票06 账键同一 token 面）
        try {
          const raw = fs.readFileSync(path.resolve(this.wikiRoot, rel), "utf-8")
          if (extractRuleAnchors(raw).includes(anchor)) return { relPath }
        } catch { /* 坏文件跳过 */ }
      }
    }
    return null
  }

  /** `_retired/` 下全部 .md 的递归清单（目录缺失⇒空；collectRetiredAnchors 同扫面，排序保确定）。 */
  private listRetiredFiles(): string[] {
    const out: string[] = []
    const walk = (dirRel: string) => {
      const abs = path.resolve(this.wikiRoot, dirRel)
      let names: string[]
      try {
        names = fs.readdirSync(abs)
      } catch {
        return
      }
      for (const n of names.sort()) {
        const rel = `${dirRel}/${n}`
        const childAbs = path.resolve(this.wikiRoot, rel)
        let st: fs.Stats
        try {
          st = fs.statSync(childAbs)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(rel)
        else if (n.endsWith(".md")) out.push(rel)
      }
    }
    walk("_retired")
    return out
  }

  private async start(id: string): Promise<void> {
    const rec = this.records.get(id)
    if (!rec || rec.status !== "queued") return
    rec.status = "running"
    rec.startedAt = this.now().toISOString()
    try {
      rec.result = this.execute(rec.path, { anchor: rec.anchor, reason: rec.reason, source: rec.source })
      rec.status = "committed"
    } catch (err) {
      const code = err instanceof PageRestoreError ? err.code : "PAGE_RESTORE_FAILED"
      const message = err instanceof Error ? err.message : String(err)
      rec.error = { code, message: message.replace(new RegExp(`^${code}: `), "") }
      rec.status = "failed"
      process.stderr.write(`[wiki-page-restore] ${id} failed: ${message}\n`)
    } finally {
      rec.finishedAt = this.now().toISOString()
    }
  }

  /**
   * 队列执行体（已持串行位）：复检 → 读退役页剥退役装饰 → **入链回补（retire commit
   * diff 反放）**→ 回迁在册位 → 删 _retired 件（先写新位再删旧位——任何时刻页有安身处）
   * → INDEX 重建 → LOG restore 行 → DB/FTS 复登（页+被回补宿主）→ 单 commit。
   * 任一步异常尽力回滚（页回 _retired/、宿主回写恢复前现文），不留半恢复。
   */
  private execute(relPath: string, opts: { anchor?: string; reason?: string; source?: string }): WikiRestoreResult {
    const dirty = this.git.run(["status", "--porcelain"])
    if (dirty.stdout.trim().length > 0) {
      throw new PageRestoreError("WORKTREE_DIRTY", "wiki 工作区存在未提交改动（不应发生：写闸全提交），拒绝恢复", 409)
    }
    const fromRel = `_retired/${relPath}`
    const retiredAbs = path.resolve(this.wikiRoot, fromRel)
    if (!fs.existsSync(retiredAbs)) {
      throw new PageRestoreError("RESTORE_TARGET_MISSING", `退役页不存在（执行段复检）：${fromRel}`, 404)
    }
    const liveAbs = path.resolve(this.wikiRoot, relPath)
    if (fs.existsSync(liveAbs)) {
      throw new PageRestoreError("RESTORE_TARGET_TAKEN", `原位已有页（执行段复检）：${relPath}`, 409)
    }
    const retiredRaw = fs.readFileSync(retiredAbs, "utf-8")
    const parsed = parseWikiFile(retiredRaw)
    if (parsed.kind !== "page") {
      throw new PageRestoreError("NOT_A_PAGE", `仅 v3 页形态可恢复（词条/判例形态不在页退役面）：${fromRel}`, 409)
    }

    // ── 1. 原号原行：剥退役装饰位（status/replaced_by），正文与锚点注释逐字留存 ──
    const liveMeta = { ...parsed.meta }
    delete (liveMeta as { status?: string }).status
    delete (liveMeta as { replaced_by?: string }).replaced_by
    const liveSerialized = serializePageMarkdown(liveMeta, parsed.body)

    const warnings: string[] = []
    const ftsWarnings: string[] = []

    // ── 2. 入链回补：定位最近一次退役 commit（git 消息头发现面），反放宿主页 diff ──
    // 保守纪律（红线2）：只有「宿主现文 == 退役后态」才自动反放；漂移/失踪让位显形。
    const restored: Array<{ relPath: string; prev: string; next: string; newBody: string }> = []
    const retireCommit = this.findRetireCommit(relPath)
    if (!retireCommit) {
      // 历史不可寻（如退役件来自迁移/旁路）——页仍回迁，只是入链不自动回补。
      warnings.push(`未寻得退役 commit（消息头「${retireCommitSubject(relPath)}」），入链回补跳过`)
    } else {
      const hosts = this.retireCommitHosts(retireCommit)
      for (const host of hosts) {
        const hostAbs = path.resolve(this.wikiRoot, host)
        if (!hostAbs.startsWith(this.wikiRoot + path.sep)) continue
        if (isManualFileTarget(this.wikiRoot, hostAbs)) continue // 写保护不松动
        if (!fs.existsSync(hostAbs)) {
          warnings.push(`宿主页已不在册（后续退役/删除），入链回补让位：${host}`)
          continue
        }
        const current = fs.readFileSync(hostAbs, "utf-8")
        const afterRetire = this.tryBlob(`${retireCommit}:${host}`)
        const beforeRetire = this.tryBlob(`${retireCommit}~1:${host}`)
        if (afterRetire === null || beforeRetire === null) {
          warnings.push(`退役 commit blob 不可读，入链回补让位：${host}`)
          continue
        }
        if (current !== afterRetire) {
          warnings.push(`宿主页退役后已被编辑（漂移），入链回补让位归人裁：${host}`)
          continue
        }
        let newBody = current
        try {
          newBody = parseWikiFile(beforeRetire).body
        } catch { /* 解析坏=body 面按原文兜底（复登步再显形） */ }
        restored.push({ relPath: host, prev: current, next: beforeRetire, newBody })
      }
    }

    // ── 3. 回迁落盘：先写在册位，再删 _retired/ 件（页任何时刻都在盘上）──
    fs.mkdirSync(path.dirname(liveAbs), { recursive: true })
    atomicWrite(liveAbs, liveSerialized)
    let retiredRemoved = false
    try {
      fs.unlinkSync(retiredAbs)
      retiredRemoved = true
      for (const r of restored) {
        atomicWrite(path.resolve(this.wikiRoot, r.relPath), r.next)
      }

      // ── 4. INDEX 程序化重建（页回在册面自动复列；永不经人手）──
      const indexPath = path.join(this.wikiRoot, WIKI_INDEX_FILE)
      atomicWrite(indexPath, renderBudgetedWikiIndex(scanWikiEntries(this.wikiRoot), GLOBAL_WIKI_ORG).content)

      // ── 5. LOG 追加 restore 行（日期走注入钟——红线6；与 retire 行同族可 grep）──
      const logPath = path.join(this.wikiRoot, WIKI_LOG_FILE)
      const logBase = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
      const noteBase = opts.reason ? `自 _retired/ 回迁 · 原号原行 · ${opts.reason}` : "自 _retired/ 回迁 · 原号原行"
      atomicWrite(logPath, logBase + formatLogRow({
        action: "restore",
        entry: relPath,
        note: restored.length > 0 ? `${noteBase} · 回补 ${restored.length} 页入链` : noteBase,
        source: opts.source ?? "dialogue",
        reviewer: "owner",
      }, this.now().toISOString().slice(0, 10)))

      // ── 6. DB/FTS 复登：页按盘现形 upsert+FTS 重写；被回补宿主正文面同步 ──
      const articles = new WikiArticleDAO(this.db)
      const pageUpsert = pageRowFromDisk(liveAbs, relPath)
      if (pageUpsert) {
        articles.upsert(pageUpsert)
        const rowid = articles.getRowid(GLOBAL_WIKI_ORG, pageUpsert.id)
        if (rowid !== undefined) {
          try {
            articles.deleteFts(rowid)
            articles.insertFts({
              rowid,
              id: pageUpsert.id,
              domain: pageUpsert.domain,
              title: pageUpsert.title,
              summary: pageUpsert.summary,
              topics: pageUpsert.topics,
              body: pageUpsert.body,
            })
          } catch (err) {
            ftsWarnings.push(`FTS 复登失败（非致命）${relPath}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } else {
        warnings.push(`回迁页解析异常，DB/FTS 未复登（盘/INDEX/LOG 已成立）：${relPath}`)
      }
      for (const r of restored) {
        const hostRow = articles.getByPath(GLOBAL_WIKI_ORG, r.relPath)
        if (!hostRow) continue // 宿主本就未在册账面（与退役 §5.5 对偶）
        const { updated_at: _ut, ...upsert } = hostRow
        this.db.transaction(() => {
          articles.upsert({ ...upsert, body: r.newBody })
          const rowid = articles.getRowid(GLOBAL_WIKI_ORG, hostRow.id)
          if (rowid === undefined) return
          try {
            articles.deleteFts(rowid)
            articles.insertFts({
              rowid,
              id: hostRow.id,
              domain: hostRow.domain,
              title: hostRow.title,
              summary: hostRow.summary,
              topics: hostRow.topics,
              body: r.newBody,
            })
          } catch (err) {
            ftsWarnings.push(`FTS 宿主同步失败（非致命）${r.relPath}: ${err instanceof Error ? err.message : String(err)}`)
          }
        })()
      }

      // ── 7. 单 commit 收口（页回迁+入链回补+INDEX+LOG 一并带上）──
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length === 0) {
        // 理论上 LOG 行必产生 diff；兜底 no-op 不抛
        return {
          path: relPath, fromRetired: fromRel, restoreCommit: wikiHead(this.git) ?? "", pageId: liveMeta.id,
          inboundRestored: restored.map(r => r.relPath), warnings, ftsWarnings,
        }
      }
      mustGit(this.git, ["commit", "-m", `restore: ${relPath} ← _retired/（原号回迁）`])
      const restoreCommit = wikiHead(this.git)
      if (!restoreCommit) throw new PageRestoreError("PAGE_RESTORE_FAILED", "恢复 commit 后 HEAD 不可读", 500)
      return {
        path: relPath, fromRetired: fromRel, restoreCommit, pageId: liveMeta.id,
        inboundRestored: restored.map(r => r.relPath), warnings, ftsWarnings,
      }
    } catch (err) {
      // 尽力回滚：宿主逐字回写恢复前现文；页回 _retired/（在册位若已写则撤）——不留半恢复
      for (const r of restored) {
        try { atomicWrite(path.resolve(this.wikiRoot, r.relPath), r.prev) } catch { /* 尽力而为 */ }
      }
      try {
        if (retiredRemoved && !fs.existsSync(retiredAbs)) {
          fs.mkdirSync(path.dirname(retiredAbs), { recursive: true })
          atomicWrite(retiredAbs, retiredRaw)
        }
        if (fs.existsSync(liveAbs)) fs.rmSync(liveAbs, { force: true })
      } catch { /* 复原尽力而为 */ }
      throw err
    }
  }

  /** git 消息头发现面：最近一条 `retire: <relPath> → _retired/（superseded）`（log 新→旧首中者）。 */
  private findRetireCommit(relPath: string): string | null {
    const log = this.git.run(["log", "--format=%H%x1f%s"])
    if (log.status !== 0) return null
    const subject = retireCommitSubject(relPath)
    for (const line of log.stdout.split("\n")) {
      const [hash, ...rest] = line.split("\x1f")
      if (hash && rest.join("\x1f").trim() === subject) return hash.trim()
    }
    return null
  }

  /** 退役 commit 触及的**宿主页**清单（摘链证据面）：.md 且非 INDEX/LOG/退役件本身。 */
  private retireCommitHosts(commit: string): string[] {
    const shown = this.git.run(["show", "--name-only", "--format=", commit])
    if (shown.status !== 0) return []
    return shown.stdout
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.endsWith(".md") && l !== "INDEX.md" && l !== "LOG.md" && !l.startsWith("_retired/"))
  }

  /** `git show <rev>:<path>` 宽容读（blob 缺席=null，不抛）。 */
  private tryBlob(revPath: string): string | null {
    const r = this.git.run(["show", revPath])
    return r.status === 0 ? r.stdout : null
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



type ArticleUpsertRow = Parameters<WikiArticleDAO["upsert"]>[0]

/** 盘页 → DB 行（entryRowFromDisk 同制式；仅 v3 页形态，revert.ts:369 对齐形状）。 */
function pageRowFromDisk(abs: string, relPath: string): ArticleUpsertRow | null {
  try {
    const parsed = parseWikiFile(fs.readFileSync(abs, "utf-8"))
    if (parsed.kind !== "page") return null
    const meta = pageEntryView(parsed.meta)
    return {
      org: GLOBAL_WIKI_ORG,
      id: meta.id,
      domain: parsed.meta.type,
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
  } catch {
    return null
  }
}
