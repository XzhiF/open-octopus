import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter, WikiCaseFrontmatter, WikiPageFrontmatter, WikiPageType } from "@octopus/shared"
import { WIKI_CASE_SECTIONS, LOCATABLE_SOURCE_RE } from "@octopus/shared"
import {
  parseEntryMarkdown,
  parseWikiFile,
  parseCaseMarkdown,
  serializeEntryMarkdown,
  serializeCaseMarkdown,
  serializePageMarkdown,
  caseEntryView,
  pageEntryView,
  pageDirForType,
  pageTypeOf,
  extractRuleAnchors,
} from "./format"
import { lintWikiEntry, lintWikiPage, lintProfileForDomain, buildSplitProposal, splitProposalFromPage, judgeRuleForms, WikiLintError, estimateTokens, WIKI_LIMITS, parseH2Sections, maxAnchorNumber, formatRuleAnchor, type RuleFormJudge, type SplitProposal } from "./lint"
import { resolveWikiRoot, ensureWikiSkeleton, WIKI_ALL_DIRS, WIKI_PAGE_GROUP_LABELS, REDISTILL_MAP_REL } from "./paths"
import { isManualFileTarget, ManualFileWriteError } from "./manual-files"
import { spawnGit, mustGit, ensureWikiGitRepo, wikiHead, type GitRunner } from "./wiki-git"
import { WikiArticleDAO, type WikiArticleRow } from "../../../db/dao/wiki-article-dao"
import { today } from "./util"

/**
 * WikiCompileService — 编译服务是 wiki 唯一写入口（spec D4 写入单一闸门的技术收口）。
 * 事务性管线（spec §服务端 API 与存储）：
 *   validate → 写页 → INDEX.md 程序化重建 → LOG.md append → DB/FTS 同步 → git commit
 * 任一步失败 ⇒ 原子回滚（临时文件 + rename 原子替换 + 前置状态快照补偿），不留半成品。
 * FTS 同步失败非致命（swallow + warning，evolution-dao L79-88 先例）。
 *
 * 票04 形态面：读 v2（domain 词条兼容可读）写 v3（type 页）；`compileEntry` 收 v3 页
 * 内容走页管线，v2 词条内容走原管线（curate/migrate 等旧通道零改动，票09 整体退场）。
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

// ── 批通道（票05：一次编译写 N 页 · 单一 git commit）──────────────────
// 契约（spec §审批废除与写入闸门 / 票面 AC1）：所有页先过同一套 v3 闸（含批内互链、
// 锚点跨页唯一、L4 合并预算），任一页失败 ⇒ 整批零副作用；写入段共享一份快照，
// 中途失败整体补偿回滚零半成品。这是票06 全局队列要整包互斥的「单次编译」单位。

export interface BatchPageInput {
  /** v3 页完整文件内容（front-matter + 正文）——批通道只收页形态 */
  content: string
  /** 文件名覆盖（默认 `{id}.md`） */
  fileName?: string
}

export interface BatchCompileOptions {
  /** LOG 行对象列（如 raw 源标题） */
  entry: string
  /** LOG 动作词（默认 compile；策展投喂管线传 ingest，prototype Tab② LOG 样例） */
  action?: string
  /** LOG 结果摘要（如 `触 3 页 · 新页 2`） */
  note: string
  /** LOG 来源列（默认 manual；策展通道填 raw 路径） */
  source?: string
  /** LOG 审核列（默认 curator） */
  reviewer?: string
}

export interface BatchPageResult {
  id: string
  type: string
  /** 相对 wiki 根的 POSIX 路径 */
  path: string
  anchors: string[]
  warnings: string[]
  /** true = 编译前该页不存在（新建页，供 DIFF 卡「新页 N」计数） */
  created: boolean
}

export interface BatchCompileResult {
  pages: BatchPageResult[]
  commit: string | null
  changed: boolean
}

/**
 * 「拆分提案入队」语义已随票04 AC5 从本模块删除：容量闸触顶改为编译失败随错误
 * 返回拆分建议（WikiLintError.suggestion），供策展人对话内自纠。审核队列其余面属票09。
 */

// 允许 hub 目录形态（entities/ent-big/README.md）；每段仍是 kebab .md、禁 '..'/绝对路径（逃逸另有 resolve 检查）
const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.md$/i

/** INDEX/LOG 导航层产物名（根级）。 */
export const WIKI_INDEX_FILE = "INDEX.md"
export const WIKI_LOG_FILE = "LOG.md"

// LOG 头（票04 v3 换行格式，prototype Tab②「INDEX.md 与 LOG.md」样例契约）。
// 旧表格 LOG 不重写——v2 行共存可读，机械转换属票07。
export const WIKI_LOG_HEADER = `# LOG.md — 时间线（append-only · 编译器自动写 · 行首「## [日期] 动作 | 对象」可 grep · 详情看 git show <hash>）

`

/** INDEX 必读节固定行（prototype Tab② INDEX 样例逐字；user_preference 为人工文件）。 */
export const WIKI_INDEX_MUST_READ_LINE = "- user_preference.md — owner 偏好（人工维护）"

export interface ScannedEntry {
  relPath: string
  meta: WikiEntryFrontmatter
  anchors: string[]
  /** 票04：cases 域条目的判例 front-matter（INDEX 判例行/统计消费）；词条为 undefined。 */
  case?: WikiCaseFrontmatter
  /** v3 统一分型：v3 页取 type；v2 词条按 domain→type 映射；判例恒 case。 */
  type: WikiPageType
  /** v3 页 front-matter 原文（仅 kind=page 有；v2/case 为 undefined——兼容读面标记）。 */
  page?: WikiPageFrontmatter
}

/** 判例文件名日期前缀（{YYYY-MM-DD}-{slug}.md）——判例是历史事件，文件名日期正当。 */
const CASE_FILE_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9._-]*\.md$/i

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
 * 扫 wiki 根上所有页/词条（真源在 fs，DB 只是索引）。
 * 目录面 = v3 五类页目录 ∪ v2 存量域目录（WIKI_ALL_DIRS，cases 重合计一次）；
 * 每目录一层 + hub 子目录一层（票02 L2：entities/ent-big/README.md + build.md）。
 * front-matter 不合规的文件跳过并告警——坏文件不能拖垮整次编译。
 * v2 词条/判例**兼容可读**（票04：为重蒸馏票07 留路）。
 */
export function scanWikiEntries(root: string): ScannedEntry[] {
  const out: ScannedEntry[] = []
  for (const dir of WIKI_ALL_DIRS) {
    const abs = path.join(root, dir)
    let dirents: fs.Dirent[] = []
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      continue // 目录尚未创建（首编译前）
    }
    const files: string[] = []
    for (const d of dirents) {
      if (d.isFile() && d.name.endsWith(".md")) files.push(`${dir}/${d.name}`)
      else if (d.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(path.join(abs, d.name)).filter(n => n.endsWith(".md")).sort()) {
            files.push(`${dir}/${d.name}/${sub}`)
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
          out.push({ relPath, meta, anchors: extractRuleAnchors(parsed.body), case: parsed.meta, type: "case" })
        } else if (parsed.kind === "page") {
          out.push({ relPath, meta: pageEntryView(parsed.meta), anchors: extractRuleAnchors(parsed.body), type: parsed.meta.type, page: parsed.meta })
        } else {
          out.push({ relPath, meta: parsed.meta, anchors: extractRuleAnchors(parsed.body), type: pageTypeOf(parsed.meta) })
        }
      } catch (err) {
        process.stderr.write(`[wiki-index] skip ${relPath}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }
  return out
}

/**
 * 重蒸馏台账剥落锚点（票07）：非 topic 迁移页按 v3 铁律不落锚点注释，原号只活在
 * `_retired/v2/redistill-map.json`。发号空间必须并入它们——否则 max+1 会重铸剥落号，
 * 历史 wiki_refs 撞进新页（故事 28 暗坑）。无台账（未重蒸馏）⇒ 空集，行为原样。
 */
function retiredLedgerAnchors(root: string): string[] {
  const out: string[] = []
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, REDISTILL_MAP_REL), "utf-8")) as { anchors?: Array<{ anchor?: unknown }> }
    if (Array.isArray(j.anchors)) out.push(...j.anchors.map(a => (a && typeof a.anchor === "string" ? a.anchor : "")).filter(Boolean))
  } catch { /* 无台账 */ }
  // 票08 页退役：退役页连同 `<!--#oct-NNN-->` 锚点整册迁 `_retired/**/*.md`（不在 scan 面）。
  // 若不并入发号空间，max+1 会重铸退役页锚点 → 撞历史 wiki_refs（永不复用铁律的退役面延伸）。
  collectRetiredAnchors(path.join(root, "_retired"), out)
  return out
}

/** 递归收集 `_retired/` 下所有 .md 页正文锚点（目录缺失⇒空，坏文件跳过）。 */
function collectRetiredAnchors(dir: string, sink: string[]): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const abs = path.join(dir, n)
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      collectRetiredAnchors(abs, sink)
    } else if (n.endsWith(".md")) {
      try {
        sink.push(...extractRuleAnchors(fs.readFileSync(abs, "utf-8")))
      } catch { /* 坏文件跳过 */ }
    }
  }
}

/**
 * 发号=全库 max+1（票面 AC2）：扫描根上所有页锚点取 `oct-NNN` 最大 +1
 * （v2 形态锚点同入空间，永不复用）；extra 可并入 DB 快照锚点（搬家窗口期防双花）；
 * 票07：重蒸馏台账的剥落锚点同样入空间（永不复用铁律的迁移面延伸）。
 * 串行编译队列（票06）落位后，本函数天然无竞态。
 */
export function nextRuleAnchor(root: string, extra: Iterable<string> = []): string {
  const used: string[] = []
  for (const e of scanWikiEntries(root)) used.push(...e.anchors)
  for (const a of extra) used.push(a)
  used.push(...retiredLedgerAnchors(root))
  return formatRuleAnchor(maxAnchorNumber(used) + 1)
}

/**
 * hub 子目录成员判定：`dir/hub/xxx.md` 且同目录有 README.md → 子页，
 * INDEX 第一跳不列（经 hub 指针三跳封顶），规则仍计入统计。
 */
export function isHubChild(e: { relPath: string }, allPaths: Set<string>): boolean {
  const p = e.relPath.split("/")
  return p.length === 3 && p[2] !== "README.md" && allPaths.has(`${p[0]}/${p[1]}/README.md`)
}

/**
 * INDEX.md 程序化重建（票04 AC3，prototype Tab② INDEX 样例逐字契约）：
 * H1 + 导航协议 blockquote + 必读节（user_preference 固定行）+ 五类分组
 * （Entities/Concepts/Topics/Sources/Cases——有页才列，计数入题头）+ Optional 节
 * （L4 预算溢出降级区）。永不经 LLM/人手写；审批遗产「待审核」统计行随概念废除删除。
 * 行式一页一行 `- {relPath} — {summary}`：entity/concept 注 `←N 源`（sources 数），
 * topic 注 `· 硬约束 ×N`（锚点数），source/case 裸行；v2 词条按 domain→type 映射进组。
 */
export function renderWikiIndex(entries: ScannedEntry[], org: string, optionalEntries: ScannedEntry[] = []): string {
  const lines: string[] = []
  lines.push(`# Octopus Knowledge Wiki — ${org}`, "")
  lines.push("> 导航协议：先读本索引 → 选页整读 → 未命中再 search API。禁止全库遍历。", "")

  lines.push("## 必读")
  lines.push(WIKI_INDEX_MUST_READ_LINE, "")

  const all = [...entries, ...optionalEntries]
  const allPaths = new Set(all.map(e => e.relPath))
  const visibleMandatory = entries.filter(e => !isHubChild(e, allPaths))
  const visibleOptional = optionalEntries.filter(e => !isHubChild(e, allPaths))

  for (const type of ["entity", "concept", "topic", "source", "case"] as const) {
    const listable = visibleMandatory.filter(e => e.type === type)
    if (listable.length === 0) continue
    lines.push(`## ${WIKI_PAGE_GROUP_LABELS[type]} (${listable.length})`)
    for (const e of listable) {
      let suffix = ""
      if (type === "entity" || type === "concept") {
        const n = e.meta.sources.length
        if (n > 0) suffix = ` ←${n} 源`
      } else if (type === "topic" && e.anchors.length > 0) {
        suffix = ` · 硬约束 ×${e.anchors.length}`
      }
      lines.push(`- ${e.relPath} — ${e.meta.summary}${suffix}`)
    }
    lines.push("")
  }

  if (visibleOptional.length > 0) {
    lines.push("## Optional （低频页 · 预算溢出自动降级）")
    for (const e of visibleOptional) {
      lines.push(`- ${e.relPath} — ${e.meta.title}`)
    }
    lines.push("")
  }

  return lines.join("\n") + "\n"
}

export interface BudgetedIndex {
  content: string
  /** 被移入 ## Optional 的页 relPath（低频=规则数少者优先，同级按路径） */
  optionalRelPaths: string[]
  /** 重排后仍超 800 token 预算（病态巨行）——调用方须拒写 */
  overBudget: boolean
}

/**
 * L4 预算闸渲染：INDEX.md ≤800 token（第一跳成本恒定纪律保留，prototype Tab②）。
 * 超限→把规则数最少的页逐一移入 Optional 直至回到预算；仍超→overBudget。
 */
export function renderBudgetedWikiIndex(
  entries: ScannedEntry[],
  org: string,
): BudgetedIndex {
  const allPaths = new Set(entries.map(e => e.relPath))
  const visible = entries.filter(e => !isHubChild(e, allPaths))
  const byLowActivity = [...visible].sort(
    (a, b) => a.anchors.length - b.anchors.length || a.relPath.localeCompare(b.relPath),
  )
  const optionalRelPaths: string[] = []
  let content = renderWikiIndex(entries, org)
  let guard = 0
  while (estimateTokens(content) > WIKI_LIMITS.INDEX_MAX_TOKENS && optionalRelPaths.length < byLowActivity.length - 1 && guard < 1000) {
    const next = byLowActivity.find(e => !optionalRelPaths.includes(e.relPath))
    if (!next) break
    optionalRelPaths.push(next.relPath)
    content = renderWikiIndex(
      visible.filter(e => !optionalRelPaths.includes(e.relPath)),
      org,
      visible.filter(e => optionalRelPaths.includes(e.relPath)),
    )
    guard++
  }
  return { content, optionalRelPaths, overBudget: estimateTokens(content) > WIKI_LIMITS.INDEX_MAX_TOKENS }
}

/**
 * LOG 行格式化（票04 AC4，prototype Tab② LOG 样例契约）：
 * `## [date] ingest|compile|query|lint|revert | title` + 续行 `  → 结果`——
 * 行首前缀可 grep（`grep "^## \[" LOG.md`）。append-only，程序化写。
 * v2 旧表格行（| 日期 | 动作 | …）不重写，共存可读（机械转换属票07）。
 */
export function formatLogRow(cols: { action: string; entry: string; note: string; source: string; reviewer: string }): string {
  return `## [${today()}] ${cols.action} | ${cols.entry}\n  → ${cols.note} · ${cols.source} · ${cols.reviewer} ✓\n`
}

export class WikiCompileService {
  private readonly db: Database.Database
  private readonly org: string
  private readonly root: string
  private readonly git: GitRunner
  private readonly articles: WikiArticleDAO
  private readonly ruleFormJudge?: RuleFormJudge

  constructor(opts: { db: Database.Database; org: string; rootDir?: string; git?: GitRunner; ruleFormJudge?: RuleFormJudge }) {
    this.db = opts.db
    this.org = opts.org
    this.root = resolveWikiRoot(opts.org, opts.rootDir)
    this.git = opts.git ?? spawnGit(this.root)
    this.articles = new WikiArticleDAO(opts.db)
    this.ruleFormJudge = opts.ruleFormJudge
  }

  get wikiRoot(): string {
    return this.root
  }

  /**
   * 质控⑥服务层主闸（manual-files.ts / ADR-0030）：唯一写闸对 user_preference.md /
   * SCHEMA.md 路径级拒写——resolve 归一后对拍，`../` 旁路形态同拦；一切调用都放在
   * 文件名正则与逃逸检查**之前**（错码必须是 MANUAL_FILE_WRITE，不退化成 INVALID_PARAM）。
   */
  private assertNotManualFile(targetAbs: string): void {
    if (isManualFileTarget(this.root, targetAbs)) {
      throw new ManualFileWriteError(
        `人工文件不可经唯一写闸落盘：${path.basename(targetAbs)}（curator 通道只写五类页目录；对 user_preference.md/SCHEMA.md 只出写保护卡建议文本，改写永远由人落笔）`,
      )
    }
  }

  /**
   * 唯一写入口。校验类错误在任何 fs/DB 副作用前抛出（天然零痕迹）；
   * 副作用中途失败走补偿回滚（词条/INDEX/LOG/DB/FTS 全部回到前状态）。
   * lint 闸在此同步执行（L1/L3/L5；L6 为编译时 LLM 判定，注入 judge 时 await）。
   * 票04 分派：判例→判例管线（P0 形态保留）；v3 页（type）→页管线（写 v3、v3 闸）；
   * v2 词条（domain）→原管线兼容读写（curate/migrate 等旧通道，票09 退场）。
   */
  async compileEntry(input: CompileInput): Promise<CompileResult> {
    const file = parseWikiFile(input.content)
    if (file.kind === "case") return this.compileCase(file.meta, file.body, input)
    if (file.kind === "page") return this.compilePage(file.meta, file.body, input)

    const warnings: string[] = []

    // ── 1. validate（无副作用段）──────────────────────────────
    const { meta, body } = parseEntryMarkdown(input.content)

    const fileName = input.fileName ?? `${meta.id}.md`
    this.assertNotManualFile(path.resolve(this.root, meta.domain, fileName))
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
      // 票04 AC5：拆分出口=随错误返回拆分建议（对话内自纠），**无入队语义**
      throw new WikiLintError(
        "L1_CAPACITY",
        `${l1.message}——拆分建议见 suggestion（按 H2 小节切分，对话内自纠后重编译）`,
        lint.errors,
        buildSplitProposal(meta, fileName, body, l1.message),
      )
    }
    for (const e of lint.errors) {
      throw new WikiLintError(e.code, e.message, lint.errors)
    }

    // ── L4 INDEX 预算闸（≤800 token，第一跳成本恒定）：预测含本词条的 INDEX，
    //    低频词条移 ## Optional 收敛；重排仍超限 → 拒写 + 拆分建议随错误返回 ──
    const predicted: ScannedEntry[] = scanWikiEntries(this.root).filter(e => e.relPath !== relPath)
    predicted.push({ relPath, meta, anchors, type: pageTypeOf(meta) })
    const budget = renderBudgetedWikiIndex(predicted, this.org)
    if (budget.overBudget) {
      const tokens = estimateTokens(budget.content)
      throw new WikiLintError(
        "L4_INDEX_BUDGET",
        `INDEX.md 约 ${tokens} token 超过预算 ${WIKI_LIMITS.INDEX_MAX_TOKENS} 且 Optional 重排无法收敛——低频词条移 ## Optional 或升 hub（拆分建议见 suggestion）`,
        [{ level: "L4", severity: "error", code: "L4_INDEX_BUDGET", message: `INDEX ${tokens} > ${WIKI_LIMITS.INDEX_MAX_TOKENS} token` }],
        this.overflowSplitSuggestion(predicted, relPath, { meta, fileName, body }),
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
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org).content)

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

  /**
   * 批通道（票05）：一次编译写 N 页 + INDEX 重建 + LOG 一行 + DB/FTS 同步 + 单一 git commit。
   * 校验段零副作用（任何一页不过闸 ⇒ 整批不落盘）；写入段共享快照，失败全量补偿回滚。
   * 与单页 compilePage 同闸同律（文件名/逃逸/锚点全库唯一/lint/L4 预算，L4 按整批合并预测），
   * 并额外强批内约束：同路径/同 id 重复输入拒绝，跨页锚点互斥，断链语料含全批（页未落盘即可互链）。
   * 幂等：所有页产物与在盘内容逐字节相同（忽略 last_compiled）⇒ 整批 no-op，
   * 不写文件、不追加 LOG、不产生 commit、changed=false（票面 S1「同 raw 重编译 diff 空」的落点）。
   */
  async compilePages(inputs: BatchPageInput[], opts: BatchCompileOptions): Promise<BatchCompileResult> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error("INVALID_PARAM: 批通道至少需要一页")
    }

    // ── 1. validate（无副作用段）──────────────────────────────
    interface PlannedPage {
      meta: WikiPageFrontmatter
      body: string
      fileName: string
      relPath: string
      absPath: string
      anchors: string[]
      warnings: string[]
      created: boolean
      /** 序列化产物（含 front-matter） */
      serialized: string
    }
    const scanned = scanWikiEntries(this.root)
    const batchPaths = new Set<string>()
    const batchIds = new Set<string>()
    const planned: PlannedPage[] = []

    for (const [i, input] of inputs.entries()) {
      const file = parseWikiFile(input.content)
      if (file.kind !== "page") {
        throw new Error(`BATCH_KIND: 批通道只收 v3 页（entity/concept/topic/source），第 ${i + 1} 页是${file.kind === "case" ? "判例" : " v2 词条"}形态——请走单页通道 compileEntry`)
      }
      const meta = file.meta
      const body = file.body
      const fileName = input.fileName ?? `${meta.id}.md`
      const dir = pageDirForType(meta.type)
      this.assertNotManualFile(path.resolve(this.root, dir, fileName))
      if (!FILE_NAME_RE.test(fileName)) {
        throw new Error(`INVALID_PARAM: 文件名不合规 '${fileName}'（要求 kebab .md，禁止路径分隔符）`)
      }
      const relPath = `${dir}/${fileName}`
      const absPath = path.resolve(this.root, dir, fileName)
      if (!absPath.startsWith(path.resolve(this.root) + path.sep)) {
        throw new Error(`INVALID_PARAM: 路径逃逸 wiki 根 '${relPath}'`)
      }
      if (batchPaths.has(relPath)) throw new Error(`BATCH_DUPLICATE_PATH: 批内两页同写 '${relPath}'`)
      if (batchIds.has(meta.id)) throw new Error(`BATCH_DUPLICATE_ID: 批内两页同 id '${meta.id}'`)
      batchPaths.add(relPath)
      batchIds.add(meta.id)

      const anchors = extractRuleAnchors(body)
      const seen = new Set<string>()
      for (const a of anchors) {
        if (seen.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 在本页内重复`)
        seen.add(a)
      }
      planned.push({ meta, body, fileName, relPath, absPath, anchors, warnings: [], created: !fs.existsSync(absPath), serialized: serializePageMarkdown(meta, body) })
    }

    // 锚点全库唯一：库内非批页（批覆盖路径旧锚点随覆写消失，不算冲突）+ 批内跨页 + DB 快照
    for (const p of planned) {
      const mine = new Set(p.anchors)
      for (const other of scanned) {
        if (batchPaths.has(other.relPath)) continue
        for (const a of other.anchors) {
          if (mine.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.relPath}（锚点全库唯一、永不复用）`)
        }
      }
      for (const q of planned) {
        if (q === p) continue
        for (const a of q.anchors) {
          if (mine.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 在批内双花（${p.relPath} 与 ${q.relPath}）`)
        }
      }
      for (const other of this.articles.listOthers(this.org, p.meta.id)) {
        if (batchPaths.has(other.path)) continue
        for (const a of extractRuleAnchors(other.body)) {
          if (mine.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.path}（DB 快照，锚点全库唯一）`)
        }
      }
    }

    // v3 闸：lintWikiPage 逐页跑；断链语料 = 库（非批覆盖路径）∪ 全批（页可互链，落盘前即成立）
    const libraryCorpus = scanned
      .filter(e => !batchPaths.has(e.relPath))
      .map(e => ({ id: e.meta.id, path: e.relPath }))
    for (const p of planned) {
      const linkCorpus = [
        ...planned.map(q => ({ id: q.meta.id, path: q.relPath })),
        ...libraryCorpus,
      ]
      const lint = lintWikiPage({ meta: p.meta, body: p.body, anchors: p.anchors, root: this.root, linkCorpus })
      for (const w of lint.warnings) p.warnings.push(w.message)
      const l1 = lint.errors.find(e => e.code === "L1_CAPACITY")
      if (l1) {
        throw new WikiLintError(
          "L1_CAPACITY",
          `${p.relPath}: ${l1.message}——拆分建议见 suggestion（按 H2 小节切分，对话内自纠后重编译）`,
          lint.errors,
          splitProposalFromPage(p.meta, p.fileName, p.body, l1.message),
        )
      }
      for (const e of lint.errors) throw new WikiLintError(e.code, `${p.relPath}: ${e.message}`, lint.errors)
    }

    // L4 INDEX 预算闸：整批合并预测（缺席批覆盖路径的旧页）
    const predicted: ScannedEntry[] = scanned.filter(e => !batchPaths.has(e.relPath))
    for (const p of planned) {
      predicted.push({ relPath: p.relPath, meta: pageEntryView(p.meta), anchors: p.anchors, type: p.meta.type, page: p.meta })
    }
    const budget = renderBudgetedWikiIndex(predicted, this.org)
    if (budget.overBudget) {
      const tokens = estimateTokens(budget.content)
      throw new WikiLintError(
        "L4_INDEX_BUDGET",
        `INDEX.md 约 ${tokens} token 超过预算 ${WIKI_LIMITS.INDEX_MAX_TOKENS} 且 Optional 重排无法收敛——低频页移 ## Optional 或升 hub`,
        [{ level: "L4", severity: "error", code: "L4_INDEX_BUDGET", message: `INDEX ${tokens} > ${WIKI_LIMITS.INDEX_MAX_TOKENS} token` }],
      )
    }

    // 幂等判定：产物与在盘内容仅差 last_compiled ⇒ 该页不写；整批皆同 ⇒ 零副作用 no-op
    const ignoringDate = (s: string) => s.replace(/\r\n/g, "\n").replace(/^last_compiled:.*$/m, "")
    const dirty = planned.filter(p => {
      if (!fs.existsSync(p.absPath)) return true
      try {
        return ignoringDate(fs.readFileSync(p.absPath, "utf-8")) !== ignoringDate(p.serialized)
      } catch {
        return true
      }
    })
    const allResults = (): BatchPageResult[] =>
      planned.map(p => ({ id: p.meta.id, type: p.meta.type, path: p.relPath, anchors: p.anchors, warnings: p.warnings, created: p.created }))
    if (dirty.length === 0) {
      return { pages: allResults(), commit: null, changed: false }
    }

    // ── 2. 前置状态快照（回滚补偿用；只快照将被改写的页）────────
    const indexPath = path.join(this.root, WIKI_INDEX_FILE)
    const logPath = path.join(this.root, WIKI_LOG_FILE)
    const prevIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf-8") : null
    const prevLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null
    const fileSnapshots = dirty.map(p => ({ absPath: p.absPath, prev: fs.existsSync(p.absPath) ? fs.readFileSync(p.absPath, "utf-8") : null }))
    const dbSnapshots = dirty.map(p => ({
      id: p.meta.id,
      prevRow: this.articles.get(this.org, p.meta.id),
      prevRowid: this.articles.getRowid(this.org, p.meta.id),
      prevFts: (() => {
        const rid = this.articles.getRowid(this.org, p.meta.id)
        return rid !== undefined ? this.articles.getFtsByRowid(rid) : undefined
      })(),
    }))

    try {
      // ── 3. fs 写（tmp+rename 原子替换）+ INDEX 重建 + LOG 单行 ──
      ensureWikiSkeleton(this.root)
      ensureWikiGitRepo(this.root, this.git)
      for (const p of dirty) atomicWrite(p.absPath, p.serialized)

      const entries = scanWikiEntries(this.root)
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org).content)

      const logBase = prevLog ?? WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({
        action: opts.action ?? "compile",
        entry: opts.entry,
        note: opts.note,
        source: opts.source ?? "manual",
        reviewer: opts.reviewer ?? "curator",
      }))

      // ── 4. DB 行 + FTS 手工对齐（单事务跨全批；FTS 失败非致命 gotcha #6）──
      for (const p of dirty) {
        const warnings = p.warnings
        this.db.transaction(() => {
          const upsert: Omit<WikiArticleRow, "updated_at"> = {
            org: this.org,
            id: p.meta.id,
            domain: p.meta.type,
            title: p.meta.title,
            summary: p.meta.summary,
            topics: JSON.stringify(p.meta.topics),
            stability: p.meta.stability ?? "stable",
            last_compiled: p.meta.last_compiled,
            sources: JSON.stringify(p.meta.sources),
            confidence: p.meta.confidence ?? 0.5,
            body: p.body,
            path: p.relPath,
          }
          this.articles.upsert(upsert)
          const rowid = this.articles.getRowid(this.org, p.meta.id)!
          try {
            this.articles.deleteFts(rowid)
            this.articles.insertFts({
              rowid,
              id: p.meta.id,
              domain: p.meta.type,
              title: p.meta.title,
              summary: p.meta.summary,
              topics: upsert.topics,
              body: p.body,
            })
            return true
          } catch (err) {
            warnings.push(`FTS 同步失败（非致命）: ${err instanceof Error ? err.message : String(err)}`)
            return false
          }
        })()
      }

      // ── 5. git commit（一次批编译 = 一个 commit）────────────
      let commit: string | null = null
      let changed = false
      mustGit(this.git, ["add", "-A"])
      const status = mustGit(this.git, ["status", "--porcelain"])
      if (status.stdout.trim().length > 0) {
        mustGit(this.git, ["commit", "-m", `${opts.action ?? "compile"}: ${opts.entry} — ${opts.note}`])
        commit = wikiHead(this.git)
        changed = true
      }

      return { pages: allResults(), commit, changed }
    } catch (err) {
      // ── 6. 原子回滚：全批快照还原，不留半成品 ────────────────
      for (const snap of fileSnapshots) restoreFile(snap.absPath, snap.prev)
      restoreFile(indexPath, prevIndex)
      restoreFile(logPath, prevLog)
      try {
        this.db.transaction(() => {
          for (const snap of dbSnapshots) {
            if (snap.prevRow) {
              this.articles.upsert(snap.prevRow)
              const rid = this.articles.getRowid(this.org, snap.prevRow.id)!
              this.articles.deleteFts(rid)
              if (snap.prevFts) this.articles.insertFts({ ...snap.prevFts, rowid: rid })
            } else {
              const rid = this.articles.getRowid(this.org, snap.id)
              if (rid !== undefined) this.articles.deleteFts(rid)
              this.articles.delete(this.org, snap.id)
            }
          }
        })()
      } catch { /* best effort — fs 真相已还原，DB 差异留给下次编译同步 */ }
      try { this.git.run(["reset"]) } catch { /* best effort */ }
      throw err
    }
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
    this.assertNotManualFile(path.resolve(this.root, "cases", relName))
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
      return this.writeCase(c, body, view, relPath, absPath, indexPath, logPath, anchors, warnings, "compile",
        input.note ?? `判例更新 status=${c.status} occurrences=${c.occurrences}${c.rule_ref ? ` rule_ref=${c.rule_ref}` : ""}`,
        source, reviewer)
    }
    return this.writeCase(c, body, view, relPath, absPath, indexPath, logPath, anchors, warnings, "compile",
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
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org).content)

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
      action: "compile",
      entry: relPath,
      note: `${what}被拒（append-only 判例即历史）`,
      source,
      reviewer,
    }))
    // 能走到拒绝说明判例文件已存在 ⇒ wiki git 仓已建立；证据行随手提交（best-effort，
    // git 抖动绝不让"留 LOG"降级为静默丢弃）
    try {
      mustGit(this.git, ["add", WIKI_LOG_FILE])
      mustGit(this.git, ["commit", "-m", `compile-rej: ${relPath} — ${what}被拒（append-only）`])
    } catch { /* LOG 文件已落盘即达标，commit 失败不升级 */ }
  }

  /**
   * L4 收敛失败时的拆分建议（票04 AC5：出口=随错误返回，**无入队语义**）：
   * 取"最胖"页（锚点最多）给按 H2 小节的 hub 化切分计划；≥2 个小节才有可拆形态，
   * 判例文件不参与拆分建议（append-only）。v2/v3 目标页都支持（分派构造器）。
   */
  private overflowSplitSuggestion(
    predicted: ScannedEntry[],
    incomingRelPath: string,
    incoming: { meta: WikiEntryFrontmatter | WikiPageFrontmatter; fileName: string; body: string },
  ): SplitProposal | undefined {
    if (predicted.length === 0) return undefined
    const largest = predicted.reduce((a, b) => (b.anchors.length > a.anchors.length ? b : a))
    let targetMeta: WikiEntryFrontmatter | WikiPageFrontmatter
    let targetFileName: string
    let targetBody: string
    if (largest.relPath === incomingRelPath) {
      targetMeta = incoming.meta
      targetFileName = incoming.fileName
      targetBody = incoming.body
    } else {
      try {
        const parsed = parseWikiFile(fs.readFileSync(path.resolve(this.root, largest.relPath), "utf-8"))
        if (parsed.kind === "case") return undefined
        targetMeta = parsed.meta
        targetFileName = largest.relPath.split("/").pop() ?? `${targetMeta.id}.md`
        targetBody = parsed.body
      } catch {
        return undefined
      }
    }
    if (parseH2Sections(targetBody).sections.length < 2) return undefined
    const reason = `L4 INDEX 预算超限——建议升 hub（${largest.relPath}）`
    return "type" in targetMeta
      ? splitProposalFromPage(targetMeta, targetFileName, targetBody, reason)
      : buildSplitProposal(targetMeta, targetFileName, targetBody, reason)
  }

  /**
   * v3 页管线（票04 基座：单页编译形态正确；raw→多页合成属票05）。
   * 与词条管线的差异：页目录按 type（entities/concepts/topics/sources）；闸用 lintWikiPage
   * （锚点小节约束 + front-matter links 断链检 + 容量按页）；锚点全库唯一对 **fs 真相**
   * （v2 存量页/判例的锚点同入空间，永不复用）；DB/FTS 的 domain 列存 v3 type 值（列名不动）。
   */
  private async compilePage(meta: WikiPageFrontmatter, body: string, input: CompileInput): Promise<CompileResult> {
    const warnings: string[] = []

    // ── 1. validate（无副作用段）──────────────────────────────
    const fileName = input.fileName ?? `${meta.id}.md`
    const dir = pageDirForType(meta.type)
    this.assertNotManualFile(path.resolve(this.root, dir, fileName))
    if (!FILE_NAME_RE.test(fileName)) {
      throw new Error(`INVALID_PARAM: 文件名不合规 '${fileName}'（要求 kebab .md，禁止路径分隔符）`)
    }
    const relPath = `${dir}/${fileName}`
    const absPath = path.resolve(this.root, dir, fileName)
    if (!absPath.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`INVALID_PARAM: 路径逃逸 wiki 根 '${relPath}'`)
    }

    // 锚点：页内去重 + 全库唯一（fs 扫描覆盖 v3/v2/判例；同路径自身重编译放行）
    const anchors = extractRuleAnchors(body)
    const seen = new Set<string>()
    for (const a of anchors) {
      if (seen.has(a)) throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 在本页内重复`)
      seen.add(a)
    }
    const scanned = scanWikiEntries(this.root)
    for (const other of scanned) {
      if (other.relPath === relPath) continue
      for (const a of other.anchors) {
        if (seen.has(a)) {
          throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.relPath}（锚点全库唯一、永不复用）`)
        }
      }
    }
    // 退役区/搬家窗口兜底：DB 快照锚点也在唯一空间内（与 v2 管线同律）
    for (const other of this.articles.listOthers(this.org, meta.id)) {
      if (other.path === relPath) continue
      for (const a of extractRuleAnchors(other.body)) {
        if (seen.has(a)) {
          throw new Error(`ANCHOR_CONFLICT: 锚点 '${a}' 已存在于 ${other.path}（锚点全库唯一、永不复用）`)
        }
      }
    }

    // ── v3 闸：L1 容量按页 / L3 小节 / L5 锚点小节·断链(links+正文)·零日期·代码块 ──
    const lint = lintWikiPage({
      meta,
      body,
      anchors,
      root: this.root,
      linkCorpus: [{ id: meta.id, path: relPath }, ...scanned.filter(e => e.relPath !== relPath).map(e => ({ id: e.meta.id, path: e.relPath }))],
    })
    for (const w of lint.warnings) warnings.push(w.message)
    const l1 = lint.errors.find(e => e.code === "L1_CAPACITY")
    if (l1) {
      throw new WikiLintError(
        "L1_CAPACITY",
        `${l1.message}——拆分建议见 suggestion（按 H2 小节切分，对话内自纠后重编译）`,
        lint.errors,
        splitProposalFromPage(meta, fileName, body, l1.message),
      )
    }
    for (const e of lint.errors) {
      throw new WikiLintError(e.code, e.message, lint.errors)
    }

    // ── L4 INDEX 预算闸：预测含本页的 INDEX，低频页移 ## Optional 收敛；仍超限→拒写+建议 ──
    const predicted: ScannedEntry[] = scanned.filter(e => e.relPath !== relPath)
    predicted.push({ relPath, meta: pageEntryView(meta), anchors, type: meta.type, page: meta })
    const budget = renderBudgetedWikiIndex(predicted, this.org)
    if (budget.overBudget) {
      const tokens = estimateTokens(budget.content)
      throw new WikiLintError(
        "L4_INDEX_BUDGET",
        `INDEX.md 约 ${tokens} token 超过预算 ${WIKI_LIMITS.INDEX_MAX_TOKENS} 且 Optional 重排无法收敛——低频页移 ## Optional 或升 hub（拆分建议见 suggestion）`,
        [{ level: "L4", severity: "error", code: "L4_INDEX_BUDGET", message: `INDEX ${tokens} > ${WIKI_LIMITS.INDEX_MAX_TOKENS} token` }],
        this.overflowSplitSuggestion(predicted, relPath, { meta, fileName, body }),
      )
    }

    // ── L6 规则形态（warn 级；注入 judge 才跑，判定失败绝不阻塞）──
    if (this.ruleFormJudge) {
      for (const f of await judgeRuleForms(body, this.ruleFormJudge)) warnings.push(f.message)
    }

    const note = input.note ?? (meta.type === "topic" && anchors.length > 0 ? `+${anchors.length} 条硬约束` : `触 1 页（${meta.type}）`)
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
      // ── 3. fs 写（tmp+rename 原子替换）+ INDEX 程序化重建 + LOG append ──
      ensureWikiSkeleton(this.root)
      ensureWikiGitRepo(this.root, this.git)

      atomicWrite(absPath, serializePageMarkdown(meta, body))

      const entries = scanWikiEntries(this.root)
      atomicWrite(indexPath, renderBudgetedWikiIndex(entries, this.org).content)

      const logBase = prevLog ?? WIKI_LOG_HEADER
      atomicWrite(logPath, logBase + formatLogRow({ action: "compile", entry: relPath, note, source, reviewer }))

      // ── 4. DB 行 + FTS：domain 列存 v3 type 值（票04 AC6，列名不动）──
      const upsert: Omit<WikiArticleRow, "updated_at"> = {
        org: this.org,
        id: meta.id,
        domain: meta.type,
        title: meta.title,
        summary: meta.summary,
        topics: JSON.stringify(meta.topics),
        stability: meta.stability ?? "stable",
        last_compiled: meta.last_compiled,
        sources: JSON.stringify(meta.sources),
        confidence: meta.confidence ?? 0.5,
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
            domain: meta.type,
            title: meta.title,
            summary: meta.summary,
            topics: upsert.topics,
            body,
          })
          return true
        } catch (err) {
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

      return { id: meta.id, domain: meta.type, path: relPath, anchors, warnings, commit, changed }
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
