import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter } from "@octopus/shared"
import {
  parseEntryMarkdown,
  serializeEntryMarkdown,
  extractRuleAnchors,
  findDateOccurrences,
} from "./format"
import { resolveWikiRoot, ensureWikiSkeleton, WIKI_DOMAINS, WIKI_DOMAIN_LABELS, type WikiDomainDir } from "./paths"
import { spawnGit, mustGit, ensureWikiGitRepo, wikiHead, type GitRunner } from "./wiki-git"
import { WikiArticleDAO, type WikiArticleRow } from "../../../db/dao/wiki-article-dao"

/**
 * WikiCompileService — 编译服务是 wiki 唯一写入口（spec D4 写入单一闸门的技术收口）。
 * 事务性管线（spec §服务端 API 与存储）：
 *   validate → 写词条 → INDEX.md 程序化重建 → LOG.md append → DB/FTS 同步 → git commit
 * 任一步失败 ⇒ 原子回滚（临时文件 + rename 原子替换 + 前置状态快照补偿），不留半成品。
 * FTS 同步失败非致命（swallow + warning，evolution-dao L79-88 先例）。
 */

export interface CompileInput {
  /** 词条完整文件内容（front-matter + 正文），格式 v2 */
  content: string
  /** 文件名覆盖（默认 `{id}.md`）；票05 迁移存量时按旧 basename 传入 */
  fileName?: string
  /** LOG 来源列（默认 manual） */
  source?: string
  /** LOG 审核列（默认 curator，渲染为 `{reviewer} ✓`） */
  reviewer?: string
  /** LOG 摘要列（默认 `+{N} 条规则`） */
  note?: string
}

export interface CompileResult {
  id: string
  domain: string
  /** 相对 wiki 根的 POSIX 路径，如 projects/prj-octopus.md */
  path: string
  anchors: string[]
  warnings: string[]
  /** 本次编译的 commit hash；无变化时 null */
  commit: string | null
  changed: boolean
}

const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.md$/i

/** INDEX/LOG 导航层产物名（根级）。 */
export const WIKI_INDEX_FILE = "INDEX.md"
export const WIKI_LOG_FILE = "LOG.md"

// Header 逐字来自 prototype.md Tab③ lines 500-507（primary source）。
export const WIKI_LOG_HEADER = `# Curation Log（append-only · 编译器自动写 · 详情看 git show <hash>）

| 日期 | 动作 | 词条 | 摘要 | 来源 | 审核 |
|------|------|------|------|------|------|
`

export interface ScannedEntry {
  relPath: string
  meta: WikiEntryFrontmatter
  anchors: string[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** tmp 文件 + 同目录 rename —— Windows/POSIX 都是原子替换；不留 tmp 垃圾。 */
function atomicWrite(target: string, content: string): void {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.tmp-${path.basename(target)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    fs.writeFileSync(tmp, content, "utf-8")
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}

/**
 * 扫 wiki 根上所有域词条（真源在 fs，DB 只是索引）。
 * front-matter 不合规的文件跳过并告警——坏文件不能拖垮整次编译。
 */
export function scanWikiEntries(root: string): ScannedEntry[] {
  const out: ScannedEntry[] = []
  for (const domain of WIKI_DOMAINS) {
    const dir = path.join(root, domain)
    let names: string[] = []
    try {
      names = fs.readdirSync(dir).filter(n => n.endsWith(".md")).sort()
    } catch {
      continue // 域目录尚未创建（首编译前）
    }
    for (const name of names) {
      const relPath = `${domain}/${name}`
      try {
        const { meta, body } = parseEntryMarkdown(fs.readFileSync(path.join(dir, name), "utf-8"))
        out.push({ relPath, meta, anchors: extractRuleAnchors(body) })
      } catch (err) {
        process.stderr.write(`[wiki-index] skip ${relPath}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }
  return out
}

/**
 * INDEX.md llms.txt 形状（prototype Tab③ lines 432-455 逐字先例）：
 * H1 + blockquote 导航协议 + H2 域节（有内容的域才列）+ 每词条一行摘要 + 统计节。
 * 纯函数、程序化重建——永不经 LLM 手写（零漂移保证，票02 L4 预算闸消费同一产物）。
 */
export function renderWikiIndex(entries: ScannedEntry[], org: string, pendingReviewCount: number): string {
  const lines: string[] = []
  lines.push(`# Octopus Knowledge Wiki — ${org}`, "")
  lines.push("> Agent 导航协议：先读本索引 → 选词条整读 → 未命中再 search API。禁止全库遍历。", "")

  let totalEntries = 0
  let totalCases = 0
  let totalRules = 0
  let lastCompiled = ""

  for (const domain of WIKI_DOMAINS) {
    const inDomain = entries.filter(e => e.meta.domain === domain)
    if (inDomain.length === 0) continue
    const rules = inDomain.reduce((s, e) => s + e.anchors.length, 0)
    const unit = domain === "cases" ? "案例" : "词条"
    const head = domain === "cases"
      ? `## cases/ （问题案例档 · ${inDomain.length} 案例 · 卡壳时按症状检索）`
      : `## ${domain}/ （${WIKI_DOMAIN_LABELS[domain]} · ${inDomain.length} 词条${rules > 0 ? ` · ${rules} 规则` : ""}）`
    lines.push(head)
    for (const e of inDomain) {
      const topics = e.meta.topics.length > 0 ? `｜topics: ${e.meta.topics.join(",")}` : ""
      lines.push(`- ${e.relPath} — ${e.meta.summary}${topics}`)
      totalRules += e.anchors.length
      if (e.meta.last_compiled > lastCompiled) lastCompiled = e.meta.last_compiled
      if (domain === "cases") totalCases++
      else totalEntries++
    }
    lines.push("")
  }

  lines.push("## 统计")
  lines.push(`词条 ${totalEntries} · 案例 ${totalCases} · 规则 ${totalRules} · 最近编译 ${lastCompiled || "—"} · 待审核 ${pendingReviewCount} ｜ 变更史见 LOG.md / git log`)
  return lines.join("\n") + "\n"
}

export function formatLogRow(cols: { action: string; entry: string; note: string; source: string; reviewer: string }): string {
  return `| ${today()} | ${cols.action} | ${cols.entry} | ${cols.note} | ${cols.source} | ${cols.reviewer} ✓ |\n`
}

export class WikiCompileService {
  private readonly db: Database.Database
  private readonly org: string
  private readonly root: string
  private readonly git: GitRunner
  private readonly articles: WikiArticleDAO

  constructor(opts: { db: Database.Database; org: string; rootDir?: string; git?: GitRunner }) {
    this.db = opts.db
    this.org = opts.org
    this.root = resolveWikiRoot(opts.org, opts.rootDir)
    this.git = opts.git ?? spawnGit(this.root)
    this.articles = new WikiArticleDAO(opts.db)
  }

  get wikiRoot(): string {
    return this.root
  }

  /**
   * 唯一写入口。校验类错误在任何 fs/DB 副作用前抛出（天然零痕迹）；
   * 副作用中途失败走补偿回滚（词条/INDEX/LOG/DB/FTS 全部回到前状态）。
   */
  compileEntry(input: CompileInput): CompileResult {
    const warnings: string[] = []

    // ── 1. validate（无副作用段）──────────────────────────────
    const { meta, body } = parseEntryMarkdown(input.content)

    const fileName = input.fileName ?? `${meta.id}.md`
    if (!FILE_NAME_RE.test(fileName)) {
      throw new Error(`INVALID_PARAM: 文件名不合规 '${fileName}'（要求 kebab .md，禁止路径分隔符）`)
    }
    const relPath = `${meta.domain}/${fileName}`
    const absPath = path.resolve(this.root, meta.domain, fileName)
    if (!absPath.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`INVALID_PARAM: 路径逃逸 wiki 根 '${relPath}'`)
    }

    // 锚点：词条内去重 + 全库唯一（对同 id 自身重编译放行）
    const anchors = extractRuleAnchors(body)
    const seen = new Set<string>()
    for (const a of anchors) {
      if (seen.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 在本词条内重复`)
      seen.add(a)
    }
    for (const other of this.articles.listOthers(this.org, meta.id)) {
      for (const a of extractRuleAnchors(other.body)) {
        if (seen.has(a)) {
          throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.path}（锚点全库唯一、永不复用）`)
        }
      }
    }

    // L5 日期预检 —— 票01 仅 warn（完整 lint 阻塞闸属票02）
    for (const d of findDateOccurrences(body)) {
      warnings.push(`L5 预检: 正文出现日期 '${d}'——常青正文应零日期（日期由 front-matter sources / LOG.md / git history 三处承接）`)
    }

    const note = input.note ?? `+${anchors.length} 条规则`
    const source = input.source ?? "manual"
    const reviewer = input.reviewer ?? "curator"

    // ── 2. 前置状态快照（回滚补偿用）──────────────────────────
    const indexPath = path.join(this.root, WIKI_INDEX_FILE)
    const logPath = path.join(this.root, WIKI_LOG_FILE)
    const prevEntry = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : null
    const prevIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null
    const prevLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null
    const prevRow = this.articles.get(this.org, meta.id)
    const prevRowid = this.articles.getRowid(this.org, meta.id)
    const prevFts = prevRowid !== undefined ? this.articles.getFtsByRowid(prevRowid) : undefined

    try {
      // ── 3. fs 写（tmp+rename 原子替换）─────────────────────
      ensureWikiSkeleton(this.root)
      ensureWikiGitRepo(this.root, this.git)

      atomicWrite(absPath, serializeEntryMarkdown(meta, body))

      const entries = scanWikiEntries(this.root)
      const pending = (this.db
        .prepare("SELECT COUNT(*) AS n FROM pending_review WHERE status IN ('pending','deferred')")
        .get() as { n: number }).n
      atomicWrite(indexPath, renderWikiIndex(entries, this.org, pending))

      const logBase = prevLog ?? WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({ action: "compile", entry: relPath, note, source, reviewer }))

      // ── 4. DB 行 + FTS 手工对齐同步（单事务；FTS 失败非致命）──
      const upsert: Omit<WikiArticleRow, "updated_at"> = {
        org: this.org,
        id: meta.id,
        domain: meta.domain,
        title: meta.title,
        summary: meta.summary,
        topics: JSON.stringify(meta.topics),
        stability: meta.stability,
        last_compiled: meta.last_compiled,
        sources: JSON.stringify(meta.sources),
        confidence: meta.confidence,
        body,
        path: relPath,
      }
      this.db.transaction(() => {
        this.articles.upsert(upsert)
        const rowid = this.articles.getRowid(this.org, meta.id)!
        try {
          this.articles.deleteFts(rowid)
          this.articles.insertFts({
            rowid,
            id: meta.id,
            domain: meta.domain,
            title: meta.title,
            summary: meta.summary,
            topics: upsert.topics,
            body,
          })
          return true
        } catch (err) {
          // external-content-less 模式：坏 FTS 绝不阻塞编译 commit（gotcha #6）
          warnings.push(`FTS 同步失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      })()

      // ── 5. git commit（一次编译一个 commit）────────────────
      let commit: string | null = null
      let changed = false
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length > 0) {
        mustGit(this.git, ["commit", "-m", `compile: ${relPath} — ${note}`])
        commit = wikiHead(this.git)
        changed = true
      }

      return { id: meta.id, domain: meta.domain, path: relPath, anchors, warnings, commit, changed }
    } catch (err) {
      // ── 6. 原子回滚：fs 快照还原 + DB 补偿，不留半成品 ─────
      this.rollbackTo(meta.id, { absPath, prevEntry, indexPath, prevIndex, logPath, prevLog, prevRow, prevRowid, prevFts })
      throw err
    }
  }

  private rollbackTo(entryId: string, prev: {
    absPath: string; prevEntry: string | null
    indexPath: string; prevIndex: string | null
    logPath: string; prevLog: string | null
    prevRow: WikiArticleRow | undefined; prevRowid: number | undefined; prevFts: ReturnType<WikiArticleDAO["getFtsByRowid"]>
  }): void {
    restoreFile(prev.absPath, prev.prevEntry)
    restoreFile(prev.indexPath, prev.prevIndex)
    restoreFile(prev.logPath, prev.prevLog)

    try {
      this.db.transaction(() => {
        if (prev.prevRow) {
          // 更新被失败：恢复旧行 + 按（可能已变的）新 rowid 重建旧 FTS 行
          this.articles.upsert(prev.prevRow)
          const rid = this.articles.getRowid(this.org, prev.prevRow.id)!
          this.articles.deleteFts(rid)
          if (prev.prevFts) this.articles.insertFts({ ...prev.prevFts, rowid: rid })
        } else {
          // 新建被失败：行与 FTS 行都从未应存在，清掉本次写入
          const rid = this.articles.getRowid(this.org, entryId)
          if (rid !== undefined) this.articles.deleteFts(rid)
          this.articles.delete(this.org, entryId)
        }
      })()
    } catch { /* best effort — fs 真相已还原，DB 差异留给下次编译同步 */ }

    try { this.git.run(["reset"]) } catch { /* best effort */ }
  }
}

function restoreFile(target: string, content: string | null): void {
  try {
    if (content === null) {
      fs.rmSync(target, { force: true })
    } else {
      atomicWrite(target, content)
    }
  } catch (err) {
    process.stderr.write(`[wiki-rollback] failed to restore ${target}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
