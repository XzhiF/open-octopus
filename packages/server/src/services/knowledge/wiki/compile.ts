import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter, WikiCaseFrontmatter } from "@octopus/shared"
import { WIKI_CASE_SECTIONS, LOCATABLE_SOURCE_RE } from "@octopus/shared"
import {
  parseEntryMarkdown,
  parseWikiFile,
  parseCaseMarkdown,
  serializeEntryMarkdown,
  serializeCaseMarkdown,
  caseEntryView,
  extractRuleAnchors,
} from "./format"
import { lintWikiEntry, lintProfileForDomain, buildSplitProposal, judgeRuleForms, WikiLintError, estimateTokens, WIKI_LIMITS, parseH2Sections, type RuleFormJudge, type SplitProposal } from "./lint"
import { resolveWikiRoot, ensureWikiSkeleton, WIKI_DOMAINS, WIKI_DOMAIN_LABELS, type WikiDomainDir } from "./paths"
import { spawnGit, mustGit, ensureWikiGitRepo, wikiHead, type GitRunner } from "./wiki-git"
import { WikiArticleDAO, type WikiArticleRow } from "../../../db/dao/wiki-article-dao"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"

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
  /**
   * 票06 审核引用：策展通道（curate）提交时携带 pending item id，
   * 进入 commit message 尾缀 `[review:<id>]` —— 审核队列 ↔ git 历史的审计链。
   */
  reviewRef?: string
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

/** L1 触顶自动入队的拆分提案 pending_review id（确定性，org+entry 唯一）。 */
export function wikiSplitProposalId(org: string, entryId: string): string {
  return `wiki-split-${org}-${entryId}`
}

// 允许 hub 目录形态（projects/prj-big/README.md）；每段仍是 kebab .md、禁 '..'/绝对路径（逃逸另有 resolve 检查）
const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.md$/i

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
  /** 票04：cases 域条目的判例 front-matter（INDEX 判例行/统计消费）；词条为 undefined。 */
  case?: WikiCaseFrontmatter
}

/** 判例文件名日期前缀（{YYYY-MM-DD}-{slug}.md）——判例是历史事件，文件名日期正当。 */
const CASE_FILE_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9._-]*\.md$/i

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
 * 域目录一层 + hub 子目录一层（票02 L2：projects/prj-big/README.md + build.md）。
 * front-matter 不合规的文件跳过并告警——坏文件不能拖垮整次编译。
 */
export function scanWikiEntries(root: string): ScannedEntry[] {
  const out: ScannedEntry[] = []
  for (const domain of WIKI_DOMAINS) {
    const dir = path.join(root, domain)
    let dirents: fs.Dirent[] = []
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 域目录尚未创建（首编译前）
    }
    const files: string[] = []
    for (const d of dirents) {
      if (d.isFile() && d.name.endsWith(".md")) files.push(`${domain}/${d.name}`)
      else if (d.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(path.join(dir, d.name)).filter(n => n.endsWith(".md")).sort()) {
            files.push(`${domain}/${d.name}/${sub}`)
          }
        } catch { /* 坏目录跳过 */ }
      }
    }
    for (const relPath of files.sort()) {
      try {
        const parsed = parseWikiFile(fs.readFileSync(path.resolve(root, relPath), "utf-8"))
        if (parsed.kind === "case") {
          // 判例视图：last_compiled 取文件名日期前缀（事件日；无则跳过视图不报错）
          const dateM = CASE_FILE_RE.exec(relPath.split("/").pop() ?? "")
          const meta = caseEntryView(parsed.meta, dateM?.[1] ?? "")
          out.push({ relPath, meta, anchors: extractRuleAnchors(parsed.body), case: parsed.meta })
        } else {
          out.push({ relPath, meta: parsed.meta, anchors: extractRuleAnchors(parsed.body) })
        }
      } catch (err) {
        process.stderr.write(`[wiki-index] skip ${relPath}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }
  return out
}

/**
 * hub 子目录成员判定：`domain/hub/xxx.md` 且同目录有 README.md → 子词条，
 * INDEX 第一跳不列（经 hub 指针三跳封顶），规则仍计入统计。
 */
export function isHubChild(e: { relPath: string }, allPaths: Set<string>): boolean {
  const p = e.relPath.split("/")
  return p.length === 3 && p[2] !== "README.md" && allPaths.has(`${p[0]}/${p[1]}/README.md`)
}

/**
 * INDEX.md llms.txt 形状（prototype Tab③ lines 432-455 逐字先例）：
 * H1 + blockquote 导航协议 + H2 域节（有内容的域才列）+ 每词条一行摘要 + 统计节。
 * 纯函数、程序化重建——永不经 LLM 手写（零漂移保证，票02 L4 预算闸消费同一产物）。
 * optionalEntries：L4 预算重排时被移出的低频词条，按 llms.txt 惯例进 `## Optional`
 * 节（只列路径+标题，不占一行摘要预算）；统计节对必选+可选全量计数。
 */
export function renderWikiIndex(entries: ScannedEntry[], org: string, pendingReviewCount: number, optionalEntries: ScannedEntry[] = []): string {
  const lines: string[] = []
  lines.push(`# Octopus Knowledge Wiki — ${org}`, "")
  lines.push("> Agent 导航协议：先读本索引 → 选词条整读 → 未命中再 search API。禁止全库遍历。", "")

  const all = [...entries, ...optionalEntries]
  const allPaths = new Set(all.map(e => e.relPath))
  const visibleMandatory = entries.filter(e => !isHubChild(e, allPaths))
  const visibleOptional = optionalEntries.filter(e => !isHubChild(e, allPaths))

  let totalEntries = 0
  let totalCases = 0
  let totalRules = 0
  let lastCompiled = ""
  for (const e of all) {
    totalRules += e.anchors.length
    if (e.meta.last_compiled > lastCompiled) lastCompiled = e.meta.last_compiled
    if (isHubChild(e, allPaths)) continue // 子词条不单独计数（经 hub 导航）
    if (e.meta.domain === "cases") totalCases++
    else totalEntries++
  }

  for (const domain of WIKI_DOMAINS) {
    const inDomainAll = all.filter(e => e.meta.domain === domain)
    if (inDomainAll.length === 0) continue
    const rules = inDomainAll.reduce((s, e) => s + e.anchors.length, 0)
    const listable = visibleMandatory.filter(e => e.meta.domain === domain)
    const head = domain === "cases"
      ? `## cases/ （问题案例档 · ${listable.length} 案例 · 卡壳时按症状检索）`
      : `## ${domain}/ （${WIKI_DOMAIN_LABELS[domain]} · ${listable.length} 词条${rules > 0 ? ` · ${rules} 规则` : ""}）`
    lines.push(head)
    for (const e of listable) {
      if (e.case) {
        // 判例行（prototype Tab③ lines 46-47 形状）：症状摘要｜tags｜×次数 → 蒸馏指针/状态
        const c = e.case
        let tail = ""
        if (c.status === "distilled" && c.rule_ref) tail = ` → 已蒸馏 ${c.rule_ref}`
        else if (c.status === "distilled") tail = "｜已蒸馏"
        else if (c.status === "superseded") tail = "｜已作废"
        else tail = "｜未蒸馏"
        lines.push(`- ${e.relPath} — ${c.symptom}｜tags: ${c.tags.join(",")}${c.occurrences > 1 ? `｜×${c.occurrences}` : ""}${tail}`)
        continue
      }
      const topics = e.meta.topics.length > 0 ? `｜topics: ${e.meta.topics.join(",")}` : ""
      lines.push(`- ${e.relPath} — ${e.meta.summary}${topics}`)
    }
    lines.push("")
  }

  if (visibleOptional.length > 0) {
    lines.push(`## Optional （低频词条 · 按需读取，L4 预算自动降级）`)
    for (const e of visibleOptional) {
      lines.push(`- ${e.relPath} — ${e.meta.title}`)
    }
    lines.push("")
  }

  lines.push("## 统计")
  lines.push(`词条 ${totalEntries} · 案例 ${totalCases} · 规则 ${totalRules} · 最近编译 ${lastCompiled || "—"} · 待审核 ${pendingReviewCount} ｜ 变更史见 LOG.md / git log`)
  return lines.join("\n") + "\n"
}

export interface BudgetedIndex {
  content: string
  /** 被移入 ## Optional 的词条 relPath（低频=规则数少者优先，同级按路径） */
  optionalRelPaths: string[]
  /** 重排后仍超 800 token 预算（病态巨行）——调用方须拒写 */
  overBudget: boolean
}

/**
 * L4 预算闸渲染：INDEX.md ≤800 token（第一跳成本恒定，prototype Tab③）。
 * 超限→把规则数最少的词条逐一移入 Optional 直至回到预算；仍超→overBudget。
 */
export function renderBudgetedWikiIndex(
  entries: ScannedEntry[],
  org: string,
  pendingReviewCount: number,
): BudgetedIndex {
  const allPaths = new Set(entries.map(e => e.relPath))
  const visible = entries.filter(e => !isHubChild(e, allPaths))
  const byLowActivity = [...visible].sort(
    (a, b) => a.anchors.length - b.anchors.length || a.relPath.localeCompare(b.relPath),
  )
  const optionalRelPaths: string[] = []
  let content = renderWikiIndex(entries, org, pendingReviewCount)
  let guard = 0
  while (estimateTokens(content) > WIKI_LIMITS.INDEX_MAX_TOKENS && optionalRelPaths.length < byLowActivity.length - 1 && guard < 1000) {
    const next = byLowActivity.find(e => !optionalRelPaths.includes(e.relPath))
    if (!next) break
    optionalRelPaths.push(next.relPath)
    content = renderWikiIndex(
      visible.filter(e => !optionalRelPaths.includes(e.relPath)),
      org,
      pendingReviewCount,
      visible.filter(e => optionalRelPaths.includes(e.relPath)),
    )
    guard++
  }
  return { content, optionalRelPaths, overBudget: estimateTokens(content) > WIKI_LIMITS.INDEX_MAX_TOKENS }
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
  private readonly pending: PendingReviewDAO
  private readonly ruleFormJudge?: RuleFormJudge

  constructor(opts: { db: Database.Database; org: string; rootDir?: string; git?: GitRunner; ruleFormJudge?: RuleFormJudge }) {
    this.db = opts.db
    this.org = opts.org
    this.root = resolveWikiRoot(opts.org, opts.rootDir)
    this.git = opts.git ?? spawnGit(this.root)
    this.articles = new WikiArticleDAO(opts.db)
    this.pending = new PendingReviewDAO(opts.db)
    this.ruleFormJudge = opts.ruleFormJudge
  }

  get wikiRoot(): string {
    return this.root
  }

  /**
   * 唯一写入口。校验类错误在任何 fs/DB 副作用前抛出（天然零痕迹）；
   * 副作用中途失败走补偿回滚（词条/INDEX/LOG/DB/FTS 全部回到前状态）。
   * 票02 lint 闸在此同步执行（L1/L3/L5；L6 为编译时 LLM 判定，注入 judge 时 await）。
   */
  async compileEntry(input: CompileInput): Promise<CompileResult> {
    // 票04：cases 域走判例管线（准入宽松 + append-only + lint 豁免）；词条管线原样（01/02）。
    const file = parseWikiFile(input.content)
    if (file.kind === "case") return this.compileCase(file.meta, file.body, input)

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
    const others = this.articles.listOthers(this.org, meta.id)
    for (const other of others) {
      for (const a of extractRuleAnchors(other.body)) {
        if (seen.has(a)) {
          throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.path}（锚点全库唯一、永不复用）`)
        }
      }
    }

    // ── 票02 lint 闸（L1 容量 / L3 小节 / L5 完整性）：errors 拒写，warnings 随结果透传 ──
    const lint = lintWikiEntry({
      meta,
      body,
      anchors,
      root: this.root,
      linkCorpus: [{ id: meta.id, path: relPath }, ...others.map(o => ({ id: o.id, path: o.path }))],
    })
    for (const w of lint.warnings) warnings.push(w.message)
    const l1 = lint.errors.find(e => e.code === "L1_CAPACITY")
    if (l1) {
      const proposalId = this.enqueueSplitProposal(meta, fileName, body, l1.message)
      const err = new WikiLintError("L1_CAPACITY", `${l1.message}——已自动生成按 H2 小节的拆分提案 '${proposalId}' 入审核队列`, lint.errors)
      err.proposalId = proposalId
      throw err
    }
    for (const e of lint.errors) {
      throw new WikiLintError(e.code, e.message, lint.errors)
    }

    // ── L4 INDEX 预算闸（≤800 token，prototype Tab③）：预测含本词条的 INDEX，
    //    低频词条移 ## Optional 收敛；重排仍超限 → 拒写 + 触发 hub 化提案 ──
    const predicted: ScannedEntry[] = scanWikiEntries(this.root).filter(e => e.relPath !== relPath)
    predicted.push({ relPath, meta, anchors })
    const budget = renderBudgetedWikiIndex(predicted, this.org, this.pendingCount())
    if (budget.overBudget) {
      const tokens = estimateTokens(budget.content)
      const largest = predicted.reduce((a, b) => (b.anchors.length > a.anchors.length ? b : a))
      const hubProposalId = this.tryHubifyProposal(largest, relPath, meta, fileName, body)
      throw new WikiLintError(
        "L4_INDEX_BUDGET",
        `INDEX.md 约 ${tokens} token 超过预算 ${WIKI_LIMITS.INDEX_MAX_TOKENS} 且 Optional 重排无法收敛——低频词条移 ## Optional 或强制升 hub${hubProposalId ? `（已触发 hub 化提案 '${hubProposalId}'）` : ""}`,
        [{ level: "L4", severity: "error", code: "L4_INDEX_BUDGET", message: `INDEX ${tokens} > ${WIKI_LIMITS.INDEX_MAX_TOKENS} token` }],
      )
    }

    // ── L6 规则形态：编译时 LLM 判定（warn 级，注入 judge 才跑——单测 fixture-mocked，
    //    离线默认零噪音；判定失败绝不阻塞编译）──
    if (this.ruleFormJudge) {
      for (const f of await judgeRuleForms(body, this.ruleFormJudge)) warnings.push(f.message)
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
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org, this.pendingCount()).content)

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
        const reviewTag = input.reviewRef ? ` [review:${input.reviewRef}]` : ""
        mustGit(this.git, ["commit", "-m", `compile: ${relPath} — ${note}${reviewTag}`])
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

  private pendingCount(): number {
    return (this.db
      .prepare("SELECT COUNT(*) AS n FROM pending_review WHERE status IN ('pending','deferred')")
      .get() as { n: number }).n
  }

  /**
   * 票04 判例管线（准入与词条不同，spec §准入策略 D5）：
   * - 准入只校验 真实 + source 可定位（task-/exec-/commit 指针）；半衰期三问豁免——
   *   判例是历史记录，"常青性"由 rule_ref 指向的规则承担，schema 里就没有 stability/confidence。
   * - lint 走 lintProfileForDomain('cases')：豁免 L1 容量闸 + 正文禁日期（事件事件绑定）。
   * - append-only：入库后正文即历史，只有 status/rule_ref/occurrences 三字段可经编译通道
   *   更新（蒸馏/次数/作废）；改写正文或其它字段的尝试 → 先落 LOG 证据行（case-rej）再拒绝。
   * 仍与词条共用：唯一写入口纪律、INDEX/LOG/DB/FTS/git 管线、事务性回滚。
   */
  private async compileCase(c: WikiCaseFrontmatter, body: string, input: CompileInput): Promise<CompileResult> {
    const warnings: string[] = []
    const relName = input.fileName ?? `${today()}-${c.id}.md`
    const dateM = CASE_FILE_RE.exec(relName)
    if (!dateM) {
      throw new Error(`CASE_FILENAME: 判例文件名必须 {YYYY-MM-DD}-{slug}.md（判例是历史事件，事件日进文件名），得到 '${relName}'`)
    }
    const relPath = `cases/${relName}`
    const absPath = path.resolve(this.root, "cases", relName)
    if (!absPath.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`INVALID_PARAM: 路径逃逸 wiki 根 '${relPath}'`)
    }
    if (!LOCATABLE_SOURCE_RE.test(c.source)) {
      throw new Error(`CASE_SOURCE_UNLOCATABLE: source '${c.source}' 不可定位——判例准入只要求"真实+可定位"，source 须指回 task-/exec-/commit/session 等可追溯指针`)
    }
    const missing = WIKI_CASE_SECTIONS.filter(s => !new RegExp(`^## ${s}(\\s|$)`, "m").test(body))
    if (missing.length > 0) {
      throw new Error(`CASE_SECTIONS_MISSING: 判例正文必须含五段（现场/诊断/根因/修复/教训），缺 ${missing.join("/")}`)
    }

    const anchors = extractRuleAnchors(body)
    const seen = new Set<string>()
    for (const a of anchors) {
      if (seen.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 在本判例内重复`)
      seen.add(a)
    }
    const others = this.articles.listOthers(this.org, c.id)
    for (const other of others) {
      for (const a of extractRuleAnchors(other.body)) {
        if (seen.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.path}（锚点全库唯一、永不复用）`)
      }
    }

    const view = caseEntryView(c, today())
    const lint = lintWikiEntry({
      meta: view,
      body,
      anchors,
      root: this.root,
      linkCorpus: [{ id: c.id, path: relPath }, ...others.map(o => ({ id: o.id, path: o.path }))],
      profile: lintProfileForDomain("cases"),
    })
    for (const w of lint.warnings) warnings.push(w.message)
    for (const e of lint.errors) throw new WikiLintError(e.code, e.message, lint.errors)

    // ── append-only 闸（先于一切写入/回滚快照）──────────────────
    const logPath = path.join(this.root, WIKI_LOG_FILE)
    const indexPath = path.join(this.root, WIKI_INDEX_FILE)
    const source = input.source ?? c.source
    const reviewer = input.reviewer ?? "curator"
    if (fs.existsSync(absPath)) {
      const prev = parseCaseMarkdown(fs.readFileSync(absPath, "utf-8"))
      const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "")
      if (norm(prev.body) !== norm(body)) {
        this.logRejection(logPath, relPath, "正文改写", source, reviewer)
        throw new Error(`CASE_APPEND_ONLY: '${relPath}' 正文已入库即历史，禁止改写（append-only；仅 status/rule_ref/occurrences 可经编译通道更新）`)
      }
      const immutable = (
        prev.meta.id !== c.id || prev.meta.symptom !== c.symptom ||
        prev.meta.severity !== c.severity || prev.meta.source !== c.source ||
        prev.meta.tags.join(",") !== c.tags.join(",")
      )
      if (immutable) {
        this.logRejection(logPath, relPath, "固定字段改写", source, reviewer)
        throw new Error(`CASE_APPEND_ONLY: '${relPath}' 仅 status/rule_ref/occurrences 可经编译通道更新，其余字段入库后不可变`)
      }
      const mutable = (
        prev.meta.status !== c.status ||
        prev.meta.rule_ref !== c.rule_ref ||
        prev.meta.occurrences !== c.occurrences
      )
      if (!mutable) {
        // 逐字节相同的重入库：无操作（不产 LOG 噪音、不产生新 commit）
        return { id: c.id, domain: "cases", path: relPath, anchors, warnings, commit: null, changed: false }
      }
      return this.writeCase(c, body, view, relPath, absPath, indexPath, logPath, anchors, warnings, "revise",
        input.note ?? `判例更新 status=${c.status} occurrences=${c.occurrences}${c.rule_ref ? ` rule_ref=${c.rule_ref}` : ""}`,
        source, reviewer)
    }
    return this.writeCase(c, body, view, relPath, absPath, indexPath, logPath, anchors, warnings, "case+",
      input.note ?? (c.occurrences > 1 ? `新案例 ×${c.occurrences} 次命中` : "新案例"),
      source, reviewer)
  }

  private writeCase(c: WikiCaseFrontmatter, body: string, view: WikiEntryFrontmatter, relPath: string, absPath: string, indexPath: string, logPath: string, anchors: string[], warnings: string[], action: string, note: string, source: string, reviewer: string): CompileResult {
    const prevEntry = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf-8") : null
    const prevIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null
    const prevLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null
    const prevRow = this.articles.get(this.org, c.id)
    const prevRowid = this.articles.getRowid(this.org, c.id)
    const prevFts = prevRowid !== undefined ? this.articles.getFtsByRowid(prevRowid) : undefined

    try {
      ensureWikiSkeleton(this.root)
      ensureWikiGitRepo(this.root, this.git)

      atomicWrite(absPath, serializeCaseMarkdown(c, body))

      const entries = scanWikiEntries(this.root)
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org, this.pendingCount()).content)

      const logBase = prevLog ?? WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({ action, entry: relPath, note, source, reviewer }))

      const upsert: Omit<WikiArticleRow, "updated_at"> = {
        org: this.org,
        id: c.id,
        domain: "cases",
        title: view.title,
        summary: view.summary,
        topics: JSON.stringify(view.topics),
        stability: "stable",
        last_compiled: view.last_compiled,
        sources: JSON.stringify(view.sources),
        confidence: 1,
        body,
        path: relPath,
      }
      this.db.transaction(() => {
        this.articles.upsert(upsert)
        const rowid = this.articles.getRowid(this.org, c.id)!
        try {
          this.articles.deleteFts(rowid)
          this.articles.insertFts({
            rowid,
            id: c.id,
            domain: "cases",
            title: view.title,
            summary: view.summary,
            topics: upsert.topics,
            body,
          })
          return true
        } catch (err) {
          warnings.push(`FTS 同步失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      })()

      let commit: string | null = null
      let changed = false
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length > 0) {
        mustGit(this.git, ["commit", "-m", `${action}: ${relPath} — ${note}`])
        commit = wikiHead(this.git)
        changed = true
      }

      return { id: c.id, domain: "cases", path: relPath, anchors, warnings, commit, changed }
    } catch (err) {
      this.rollbackTo(c.id, { absPath, prevEntry, indexPath, prevIndex, logPath, prevLog, prevRow, prevRowid, prevFts })
      throw err
    }
  }

  /** append-only 违例先落 LOG 证据行再拒绝——"改写尝试被拒并留 LOG"（票04 验收项）。 */
  private logRejection(logPath: string, relPath: string, what: string, source: string, reviewer: string): void {
    const base = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : WIKI_LOG_HEADER
    atomicWrite(logPath, base + formatLogRow({
      action: "case-rej",
      entry: relPath,
      note: `${what}被拒（append-only 判例即历史）`,
      source,
      reviewer,
    }))
    // 能走到拒绝说明判例文件已存在 ⇒ wiki git 仓已建立；证据行随手提交（best-effort，
    // git 抖动绝不让"留 LOG"降级为静默丢弃）
    try {
      mustGit(this.git, ["add", WIKI_LOG_FILE])
      mustGit(this.git, ["commit", "-m", `case-rej: ${relPath} — ${what}被拒（append-only）`])
    } catch { /* LOG 文件已落盘即达标，commit 失败不升级 */ }
  }

  /**
   * L4 收敛失败时给"最胖"词条触发 hub 化拆分提案：≥2 个 H2 小节才有可拆形态。
   * 返回提案 id；不可拆时返回 null（错误信息里自然省略提案话术）。
   */
  private tryHubifyProposal(
    largest: ScannedEntry,
    incomingRelPath: string,
    incomingMeta: WikiEntryFrontmatter,
    incomingFileName: string,
    incomingBody: string,
  ): string | null {
    let targetMeta: WikiEntryFrontmatter
    let targetFileName: string
    let targetBody: string
    if (largest.relPath === incomingRelPath) {
      targetMeta = incomingMeta
      targetFileName = incomingFileName
      targetBody = incomingBody
    } else {
      try {
        const parsed = parseEntryMarkdown(fs.readFileSync(path.resolve(this.root, largest.relPath), "utf-8"))
        targetMeta = parsed.meta
        targetFileName = largest.relPath.split("/").pop() ?? `${targetMeta.id}.md`
        targetBody = parsed.body
      } catch {
        return null
      }
    }
    if (parseH2Sections(targetBody).sections.length < 2) return null
    return this.enqueueSplitProposal(targetMeta, targetFileName, targetBody, `L4 INDEX 预算超限——建议升 hub（${largest.relPath}）`)
  }

  /**
   * L1/L4 触顶 → 拆分提案幂等入队 pending_review（type 'wiki-split'）。
   * 同 id 已存在时刷新 content（重复编译不产生重复提案）。
   */
  private enqueueSplitProposal(meta: WikiEntryFrontmatter, fileName: string, body: string, reason: string): string {
    const proposal: SplitProposal = buildSplitProposal(meta, fileName, body, reason)
    const id = wikiSplitProposalId(this.org, meta.id)
    const row = {
      id,
      type: "wiki-split",
      source: "wiki-lint",
      source_ref: meta.id,
      source_label: `词条 ${meta.id} 超容量`,
      content: JSON.stringify(proposal),
      target_file: proposal.path,
      scope: "wiki",
      conflicts: null,
      confidence: 1.0,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    }
    if (this.pending.getById(id)) this.pending.updateContent(id, row.content)
    else this.pending.insert(row)
    return id
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
