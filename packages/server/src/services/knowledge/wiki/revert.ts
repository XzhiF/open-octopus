import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"
import { GLOBAL_WIKI_ORG, WIKI_RETIRED_DIR, resolveKnowledgeRoot } from "../global-paths"
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
import { parseWikiFile, pageEntryView, caseEntryView, pageTypeOf } from "./format"
import { spawnGit, mustGit, wikiHead, type GitRunner } from "./wiki-git"
import { today } from "./util"

/**
 * 回滚服务 — 知识中心票12 AC5；票02（P4）语义改造为**状态重建**（spec 故事 22-23）。
 *
 * 语义：回滚任意历史编译 commit T —— 读 `T^ → T` 的树 diff，把每个被触及页文件强制
 * 回退到 T^ 态（T 新增→删除 · T 删除→按 T^ blob 重建 · T 修改→T^ blob 覆盖），
 * INDEX 程序化重建，LOG append `## [date] deep-revert | compile <short>` 审计行
 * （历史行零回退——append-only 审计面换芯），DB+FTS 同步，单新 commit 收口。
 * git revert 三方合并路径退役：**REVERT_CONFLICT 不再产生**——状态重建无冲突面，
 * D-kc15-3「历史越深共行漂移越大、三方合并必冲突」自然消失（INDEX/LOG 两枚程序化
 * 文件根本不进 git 合并面；页面强制对齐，后写不改判定）。页文件回滚无半成品：blob
 * 全部先读（纯读段）再集中一次写，异常路径 best-effort reset 工作区回 HEAD。
 * _retired 面同理：T 若为迁页 commit（退役/重蒸馏），回滚对称还原活页并删退役位；
 * 还原活页时 `_retired/` 下同路径镜像存在（该页其后被退役）一并摘除——活页=正典，
 * 防锚点台账（retiredLedgerAnchors）与在册面双登记。
 *
 * 一切回滚经票06 全局 FIFO 队列 `opKind="revert"` 串行执行（旁路写 wiki = 违规；
 * 语义换芯不换闸，红线1）；跨进程锁占用在执行段显形为任务级 failed（LOCK_HELD），
 * 工作区脏为 WORKTREE_DIRTY——两者保留。registry 形态与 CuratorTaskService 同律
 * （进程内 Map，超容量逐出终态；真相面 = git commit 本身 + LOG 行）。raw/ 零触碰
 * （不可变源不参与回滚，也不在 wiki git 仓内）。
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
  /** 新生成的回滚 commit 全 hash（单 commit：页状态重建+INDEX 重建+LOG deep-revert 行） */
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
/** git 惯用空树 blob hash（SHA-1 仓常量）：回滚根 commit 时作参照树（票02 状态重建边界）。 */
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

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
   * 队列执行体（已持串行位）：读 `T^ → T` 树 diff → 页文件强制重建至 T^ 态（无 git
   * 合并面 ⇒ 无冲突）→ INDEX 程序化重建 → LOG append deep-revert 行 → DB/FTS 逐页
   * 重同步 → 单 commit 收口。blob 全部先读（纯读段）再开 fs 写段；执行体异常
   * best-effort reset --hard 工作区回 HEAD（不留半成品）。
   */
  private execute(target: string): WikiRevertResult {
    const dirty = this.git.run(["status", "--porcelain"])
    if (dirty.stdout.trim().length > 0) {
      throw new RevertError("WORKTREE_DIRTY", "wiki 工作区存在未提交改动（不应发生：写闸全提交），拒绝回滚", 409)
    }

    // 目标态参照树 = T^（根 commit 无可解析父 → 空树，回滚语义 = 页全撤）
    const parent = this.git.run(["rev-parse", "--verify", "--quiet", `${target}^`])
    const base = parent.status === 0 ? `${target}^` : EMPTY_TREE_SHA1
    // T 的正向改动清单；--no-renames 把 rename 拆为 D+A 对（状态面只剩 A/D/M/T 四码），
    // --quotepath=false 保中文/特殊路径逐字回传（blob 读与 fs 写共用同一 relPath）
    const nameStatus = mustGit(this.git, [
      "-c", "core.quotepath=false",
      "diff", "--no-renames", "--name-status", base, target,
    ]).stdout

    // ── 纯读段：触及清单 + 全部待还原 blob 先入内存，读段失败不落任何 fs 写 ──
    const touched: RevertTouchedFile[] = []
    const ops: Array<RevertTouchedFile & { restore: string | null }> = []
    for (const line of nameStatus.split("\n")) {
      const parts = line.trim().split("\t")
      if (parts.length < 2) continue
      const code = parts[0][0]
      const relPath = parts[parts.length - 1]
      // INDEX/LOG 是程序化文件不进页清单：INDEX 全量重建（按盘现形）、LOG 永不回退
      // ——旧语义「revert 撤原 compile 行」由状态重建换成「历史行保留 + deep-revert 行」
      if (relPath === WIKI_INDEX_FILE || relPath === WIKI_LOG_FILE) continue
      const action: RevertTouchedFile["action"] = code === "A" ? "removed" : code === "D" ? "readded" : "restored"
      const restore = code === "A" ? null : this.readBlob(`${base}:${relPath}`)
      touched.push({ path: relPath, action })
      ops.push({ path: relPath, action, restore })
    }

    const articles = new WikiArticleDAO(this.db)
    const ftsWarnings: string[] = []
    try {
      // ── fs 段①：页文件强制对齐目标态（removed=撤销 T 的新增；readded/restored=回 T^ 版）──
      for (const op of ops) {
        const abs = path.join(this.wikiRoot, op.path)
        if (op.action === "removed") {
          fs.rmSync(abs, { force: true })
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true })
          atomicWrite(abs, op.restore ?? "")
          // _retired 面处置：活页回在册面时，`_retired/` 下同路径镜像（该页其后被
          // 退役/迁走过）一并摘除——活页=正典，防 retiredLedgerAnchors 与在册面双登记
          if (!op.path.startsWith(`${WIKI_RETIRED_DIR}/`)) {
            const mirror = path.join(this.wikiRoot, WIKI_RETIRED_DIR, op.path)
            if (fs.existsSync(mirror)) fs.rmSync(mirror, { force: true })
          }
        }
      }

      // ── fs 段②：INDEX 程序化重建（永不经人手，spec §三层架构；回滚后按盘现形）──
      const indexPath = path.join(this.wikiRoot, WIKI_INDEX_FILE)
      if (fs.existsSync(this.wikiRoot)) {
        const entries = scanWikiEntries(this.wikiRoot)
        atomicWrite(indexPath, renderBudgetedWikiIndex(entries, GLOBAL_WIKI_ORG).content)
      }

      // ── fs 段③：LOG append deep-revert 行（故事23 审计面：目标 commit + 重建页数；
      // 与既有 revert 行同族可 grep——`grep 'revert | compile'` 新旧行通吃；读面
      // LOG_LINE_RE op 字符集含连字符，零改动；日期走注入时钟——红线6）──
      const logPath = path.join(this.wikiRoot, WIKI_LOG_FILE)
      const logBase = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({
        action: "deep-revert",
        entry: `compile ${target.slice(0, 7)}`,
        note: "回滚本次编译",
        source: `状态重建 ${touched.length} 页`,
        reviewer: "owner",
      }, this.now().toISOString().slice(0, 10)))

      // ── DB/FTS 逐页重同步：在盘 ⇒ upsert+FTS 重写；不在盘 ⇒ 行+FTS 删除 ──
      // _retired/** 与非 .md 不在在册页面（scanWikiEntries 摘除面，笔记01 §2.3），不登账
      for (const t of touched) {
        if (t.path.startsWith(`${WIKI_RETIRED_DIR}/`) || !t.path.endsWith(".md")) continue
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
          const found = articles.getByPath(GLOBAL_WIKI_ORG, t.path)
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

      // ── 单 commit 收口（add -A 把页重建+INDEX+LOG 一并带上；锁文件已 exclude）──
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length === 0) {
        // 理论上不可能（LOG 行必产生 diff）；兜底不抛，回滚语义 = no-op
        return { target, revertCommit: wikiHead(this.git) ?? target, touched, ftsWarnings }
      }
      mustGit(this.git, ["commit", "-m", `deep-revert: ${target.slice(0, 7)} — 回滚本次编译（重建 ${touched.length} 页）`])
      const revertCommit = wikiHead(this.git)
      if (!revertCommit) throw new RevertError("REVERT_FAILED", "回滚 commit 后 HEAD 不可读", 500)
      return { target, revertCommit, touched, ftsWarnings }
    } catch (err) {
      // 执行体异常（fs 写半程 / commit 失败）：状态重建无 git revert 状态机可 abort，
      // best-effort reset --hard 把 tracked 面拉回 HEAD（不留半成品；ignored 面
      // ——锁文件/info-exclude——不受影响）
      const reset = this.git.run(["reset", "--hard", "HEAD"])
      if (reset.status !== 0) this.git.run(["checkout", "--", "."])
      throw err
    }
  }

  /** 参照树 blob 读取（`git show <rev>:<path>`，原始字节无 checkout filter）。 */
  private readBlob(revPath: string): string {
    return mustGit(this.git, ["show", revPath]).stdout
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
