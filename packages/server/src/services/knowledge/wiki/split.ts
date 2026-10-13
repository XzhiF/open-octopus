import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter } from "@octopus/shared"
import { parseEntryMarkdown, serializeEntryMarkdown } from "./format"
import { parseH2Sections, slugifySection, lintWikiEntry, WIKI_LIMITS, type SplitProposal } from "./lint"
import { resolveWikiRoot, WIKI_DOMAINS } from "./paths"
import { spawnGit, mustGit, ensureWikiGitRepo, wikiHead, type GitRunner } from "./wiki-git"
import { WikiArticleDAO, type WikiArticleRow, type WikiArticleUpsert } from "../../../db/dao/wiki-article-dao"
import { type PendingReviewRow } from "../../../db/dao/pending-review-dao"
import { today, escapeRe } from "./util"
import {
  scanWikiEntries,
  renderBudgetedWikiIndex,
  formatLogRow,
  WIKI_INDEX_FILE,
  WIKI_LOG_FILE,
  WIKI_LOG_HEADER,
} from "./compile"

/**
 * WikiSplitService — L2 拆分执行（票02）：审核队列里的 wiki-split 提案被采纳后，
 * 把"文件长大成目录"（prototype Tab③ L2 演进图）：
 *
 *   projects/prj-big.md  →  projects/prj-big/README.md   (hub ≤40 行：子词条一行摘要+指针)
 *                            projects/prj-big/build.md    (小节原文，锚点原样跟随)
 *                            ...
 *
 * 纪律：规则 id 永不因拆分改变（effectiveness/引用不断链）；全库 [[wikilink]] 路径式
 * 引用改写到 hub 新路径；INDEX 程序化重建（只列 hub，导航 INDEX→hub→子词条 三跳封顶）；
 * git 层 mv + split commit。提案 content 是人审计划快照，执行以盘上当前正文为准
 * （H2 小节结构重新切分），二者同构。
 */

export interface SplitApplyResult {
  hubPath: string
  childrenPaths: string[]
  commit: string | null
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = path.join(path.dirname(target), `.tmp-${path.basename(target)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    fs.writeFileSync(tmp, content, "utf-8")
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}

export class WikiSplitService {
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

  applyProposal(item: PendingReviewRow): SplitApplyResult {
    const proposal = JSON.parse(item.content) as SplitProposal
    if (proposal.kind !== "wiki-split") throw new Error(`SPLIT_BAD_PROPOSAL: kind=${proposal.kind}`)

    const relOld = proposal.path.replace(/\\/g, "/")
    const absOld = path.resolve(this.root, relOld)
    if (!fs.existsSync(absOld)) throw new Error(`SPLIT_NOT_FOUND: ${relOld} 不在盘上（可能已被处理）`)

    const { meta, body } = parseEntryMarkdown(fs.readFileSync(absOld, "utf-8"))
    const { preamble, sections } = parseH2Sections(body)
    if (sections.length < 2) throw new Error("SPLIT_NOT_APPLICABLE: 少于 2 个 H2 小节，无 hub 形态可拆")

    const base = relOld.split("/").pop()!.replace(/\.md$/i, "")
    const hubDirRel = `${meta.domain}/${base}`
    const hubRel = `${hubDirRel}/README.md`

    // ── 子词条切分（锚点原样跟随；id 派生 parent-slug，kebab 合规）──
    const used = new Set<string>()
    const children = sections.map((s, i) => {
      let slug = slugifySection(s.title, i)
      while (used.has(slug)) slug = `${slug}-${i + 1}`
      used.add(slug)
      const childMeta: WikiEntryFrontmatter = {
        ...meta,
        id: `${meta.id}-${slug}`,
        title: s.title,
        summary: `${s.title}（拆分自 ${meta.id}）`,
        last_compiled: today(),
      }
      const childBody = `# ${s.title}\n\n` + s.lines.join("\n").replace(/^\n+/, "")
      return { slug, meta: childMeta, body: childBody, anchors: s.anchors, rel: `${hubDirRel}/${slug}.md` }
    })

    // ── hub README：原 preamble + 每子词条一行摘要+指针；≤40 行（prototype L2）──
    const pre = preamble.join("\n").trim()
    const hubBody =
      (pre ? pre + "\n\n" : "") +
      "## 子词条\n" +
      children.map(c => `- [[${c.rel.replace(/\.md$/, "")}]] — ${c.meta.summary}（${c.anchors.length} 规则）`).join("\n") +
      "\n"
    const hubMeta: WikiEntryFrontmatter = { ...meta, last_compiled: today() }
    const hubContent = serializeEntryMarkdown(hubMeta, hubBody)
    const hubLines = hubContent.replace(/\n+$/, "").split("\n").length
    if (hubLines > WIKI_LIMITS.HUB_MAX_LINES) {
      throw new Error(`HUB_MAX_LINES: hub README ${hubLines} 行 > ${WIKI_LIMITS.HUB_MAX_LINES}——需先二级拆分（小节数 ${children.length}）`)
    }

    // ── 拆分产物也是写入：每个子词条过同一 lint 闸（无旁路纪律），errors → 拒拆（零副作用）──
    const corpus = [
      { id: meta.id, path: hubRel },
      ...children.map(c => ({ id: c.meta.id, path: c.rel })),
      ...this.articles.listOthers(this.org, meta.id).map(o => ({ id: o.id, path: o.path })),
    ]
    for (const c of children) {
      const r = lintWikiEntry({ meta: c.meta, body: c.body, anchors: c.anchors, root: this.root, linkCorpus: corpus })
      if (r.errors.length > 0) {
        throw new Error(`SPLIT_LINT_FAIL: ${c.rel} — ${r.errors.map(e => e.message).join("; ")}`)
      }
    }

    // ── 前置快照（中途失败补偿回滚）──
    const indexPath = path.join(this.root, WIKI_INDEX_FILE)
    const logPath = path.join(this.root, WIKI_LOG_FILE)
    const prevIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null
    const prevLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null
    const prevParentRow = this.articles.get(this.org, meta.id)
    const prevParentRowid = prevParentRow ? this.articles.getRowid(this.org, meta.id) : undefined
    const prevParentFts = prevParentRowid !== undefined ? this.articles.getFtsByRowid(prevParentRowid) : undefined
    const touchedRefs: Array<{ rel: string; prevRaw: string; prevRow: WikiArticleRow | undefined; prevRowid: number | undefined; prevFts: ReturnType<WikiArticleDAO["getFtsByRowid"]> }> = []

    try {
      ensureWikiGitRepo(this.root, this.git)

      // 1) git mv：旧文件 → hub README（git 层体现移动），再覆写 README 内容
      fs.mkdirSync(path.resolve(this.root, hubDirRel), { recursive: true })
      mustGit(this.git, ["mv", relOld, hubRel])
      atomicWrite(path.resolve(this.root, hubRel), hubContent)

      // 2) 子词条落盘
      for (const c of children) atomicWrite(path.resolve(this.root, c.rel), serializeEntryMarkdown(c.meta, c.body))

      // 3) 全库 [[wikilink]] 路径式引用改写 → hub（不断链；裸 id 引用天然仍解析到 hub id）
      const linkRe = new RegExp(`\\[\\[(${escapeRe(relOld)}|${escapeRe(relOld.replace(/\.md$/i, ""))})(?=[\\|#\\]])`, "g")
      const hubLink = hubRel.replace(/\.md$/i, "")
      for (const rel of listAllEntryFiles(this.root)) {
        if (rel === hubRel || rel.startsWith(`${hubDirRel}/`)) continue
        const abs = path.resolve(this.root, rel)
        const raw = fs.readFileSync(abs, "utf-8")
        if (!linkRe.test(raw)) continue
        linkRe.lastIndex = 0
        const rewritten = raw.replace(linkRe, `[[${hubLink}`)
        const prevRow = rel === relOld ? undefined : this.rowByPath(rel)
        if (prevRow) {
          const prevRowid = this.articles.getRowid(this.org, prevRow.id)
          const prevFts = prevRowid !== undefined ? this.articles.getFtsByRowid(prevRowid) : undefined
          touchedRefs.push({ rel, prevRaw: raw, prevRow, prevRowid, prevFts })
        }
        atomicWrite(abs, rewritten)
      }

      // 4) DB 同步：parent 行改指 hub + 子词条行 + FTS 手工对齐（含被改写引用的行）
      const { meta: hubParsedMeta, body: hubParsedBody } = parseEntryMarkdown(hubContent)
      this.db.transaction(() => {
        syncRow(this.articles, this.org, hubParsedMeta, hubParsedBody, hubRel)
        for (const c of children) syncRow(this.articles, this.org, c.meta, c.body, c.rel)
        for (const t of touchedRefs) {
          const parsed = parseEntryMarkdown(fs.readFileSync(path.resolve(this.root, t.rel), "utf-8"))
          syncRow(this.articles, this.org, parsed.meta, parsed.body, t.rel)
        }
      })()

      // 5) INDEX 程序化重建（L4 预算闸同口径；只列 hub，子词条经 hub 指针三跳可达）
      const entries = scanWikiEntries(this.root)
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org).content)

      // 6) LOG append（append-only）
      const logBase = prevLog ?? WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({
        action: "split",
        entry: relOld,
        note: `升 hub ${hubDirRel}/（hub+${children.length} 子词条，锚点跟随）`,
        source: item.source,
        reviewer: "curator",
      }))

      // 7) git commit：一次拆分一个 commit
      mustGit(this.git, ["add", "-A"])
      let commit: string | null = null
      if (mustGit(this.git, ["status", "--porcelain"]).stdout.trim().length > 0) {
        mustGit(this.git, ["commit", "-m", `split: ${relOld} → ${hubDirRel}/ (hub+${children.length})`])
        commit = wikiHead(this.git)
      }

      return { hubPath: hubRel, childrenPaths: children.map(c => c.rel), commit }
    } catch (err) {
      // ── 补偿回滚：盘 + git index + DB 全回前态，不留半拆形态 ──
      try {
        fs.rmSync(path.resolve(this.root, hubDirRel), { recursive: true, force: true })
        if (!fs.existsSync(absOld)) atomicWrite(absOld, serializeEntryMarkdown(meta, body))
        if (prevIndex === null) fs.rmSync(indexPath, { force: true })
        else atomicWrite(indexPath, prevIndex)
        if (prevLog === null) fs.rmSync(logPath, { force: true })
        else atomicWrite(logPath, prevLog)
        for (const t of touchedRefs) {
          atomicWrite(path.resolve(this.root, t.rel), t.prevRaw)
        }
        this.db.transaction(() => {
          for (const c of children) {
            const rid = this.articles.getRowid(this.org, c.meta.id)
            if (rid !== undefined) this.articles.deleteFts(rid)
            this.articles.delete(this.org, c.meta.id)
          }
          for (const t of touchedRefs) {
            if (!t.prevRow) continue
            this.articles.upsert(rowToUpsert(t.prevRow))
            const rid = this.articles.getRowid(this.org, t.prevRow.id)
            if (rid !== undefined) {
              this.articles.deleteFts(rid)
              if (t.prevFts) this.articles.insertFts({ ...t.prevFts, rowid: rid })
            }
          }
          if (prevParentRow) {
            this.articles.upsert(rowToUpsert(prevParentRow))
            const rid = this.articles.getRowid(this.org, prevParentRow.id)
            if (rid !== undefined) {
              this.articles.deleteFts(rid)
              if (prevParentFts) {
                try { this.articles.insertFts({ ...prevParentFts, rowid: rid }) } catch { /* 非致命 */ }
              }
            }
          }
        })()
        try { this.git.run(["reset"]) } catch { /* best effort */ }
      } catch { /* 补偿尽力而为；原始错误照抛 */ }
      throw err
    }
  }

  private rowByPath(rel: string): WikiArticleRow | undefined {
    return this.db.prepare("SELECT * FROM wiki_articles WHERE org = ? AND path = ?").get(this.org, rel) as WikiArticleRow | undefined
  }
}

function rowToUpsert(row: WikiArticleRow): WikiArticleUpsert {
  return {
    org: row.org, id: row.id, domain: row.domain, title: row.title, summary: row.summary,
    topics: row.topics, stability: row.stability, last_compiled: row.last_compiled,
    sources: row.sources, confidence: row.confidence, body: row.body, path: row.path,
  }
}

/** 全部词条文件（含域下一层子目录），排除 _retired。 */
function listAllEntryFiles(root: string): string[] {
  const out: string[] = []
  for (const domain of WIKI_DOMAINS) {
    const dir = path.join(root, domain)
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      const abs = path.join(dir, n)
      if (n.endsWith(".md") && fs.statSync(abs).isFile()) out.push(`${domain}/${n}`)
      else if (fs.statSync(abs).isDirectory()) {
        try {
          for (const sub of fs.readdirSync(abs).filter(x => x.endsWith(".md")).sort()) {
            out.push(`${domain}/${n}/${sub}`)
          }
        } catch { /* ignore */ }
      }
    }
  }
  return out
}

/** 写行 + FTS 对齐（org 由服务持有；external-content-less 手工 rowid 模式）。 */
function syncRow(articles: WikiArticleDAO, org: string, meta: WikiEntryFrontmatter, body: string, relPath: string): void {
  articles.upsert({
    org,
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
  })
  const rid = articles.getRowid(org, meta.id)
  if (rid === undefined) return
  try {
    articles.deleteFts(rid)
    articles.insertFts({ rowid: rid, id: meta.id, domain: meta.domain, title: meta.title, summary: meta.summary, topics: JSON.stringify(meta.topics), body })
  } catch { /* FTS 失败非致命（gotcha #6） */ }
}
