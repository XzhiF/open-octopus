import type Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import type { WikiEntryFrontmatter } from "@octopus/shared"
import { WikiCompileService, scanWikiEntries, type CompileResult } from "./compile"
import type { GitRunner } from "./wiki-git"
import type { RuleFormJudge, SplitProposal } from "./lint"
import { serializeEntryMarkdown } from "./format"
import { ensureWikiSkeleton } from "./paths"
import { today } from "./util"
import { estimateTokens } from "./lint"

/**
 * 初始编译迁移（票05）— 一次性幂等命令，把存量知识编译进 wiki。
 * spec §服务端 API 与存储（初始编译）/ prototype Tab③「初始编译」表：
 *   - org knowledge/{projects,workflows}/*.md（无 front-matter 旧格式）→ v2 词条
 *   - 规则行内 `<!-- id:X | date | source -->` 收编进 front-matter sources + LOG 首编译行
 *   - 旧规则 id（含 '/'，过不了 isValidRuleId / 词条 schema）映射为新锚点 oct-NNN，
 *     永不复用、永不冲突 —— 映射表落 wiki 根 `_migration/state.json`（git 管理，审计锚）
 *   - 一切写入仍经唯一闸门 WikiCompileService.compileEntry（lint/INDEX/LOG/FTS/git 免费获得）
 *
 * 幂等键 = 源文件内容 sha256 + 锚点映射表。重跑时 hash 未变且词条在盘 ⇒ 整个跳过
 * （不调 compileEntry ⇒ 不追加 LOG、不产生 git diff、不重复锚点）。
 * 旧知识目录（无 orgs/ 段的历史布局 ~/.octopus/{org}/knowledge/）兼容读取一次；
 * 迁移后旧目录只读保留（不删除 —— P2 另议，红线）。
 */

const MIGRATION_DIR = "_migration"
const STATE_FILE = "state.json"

/** 存量迁移词条的静态初始置信度（spec：本期 confidence 为静态初值，滚动更新属 P4）。 */
const MIGRATED_CONFIDENCE = 0.8

/** GLOSSARY-MAP 源在映射表里的登记名。 */
const GLOSSARY_REL = "GLOSSARY-MAP.md"
/** 术语词条切块预算：留 margin 于 L1（25 规则/2000 token/120 行）与 L3（H2 ≤10 规则）。 */
const GLOSSARY_MAX_RULES = 10
const GLOSSARY_MAX_TOKENS = 1300

export interface AnchorPair {
  legacy: string
  anchor: string
}

export interface MigrationReport {
  /** 本次实际编译的源 → 产物（每源文件一个独立 commit，LOG 对应） */
  compiled: Array<{
    source: string
    entryId: string
    path: string
    commit: string | null
    anchors: AnchorPair[]
  }>
  /** hash 未变且词条在盘 ⇒ 跳过（幂等证明的主体） */
  skipped: string[]
  /** 单源失败不中断整体（lint 拒写等），错误与拆分建议留报告（票04：无入队语义） */
  failed: Array<{ source: string; error: string; splitSuggestion?: SplitProposal }>
  totals: { entries: number; rules: number }
}

interface SourceState {
  hash: string
  origin: "current" | "legacy"
  entryId: string
  /** 词条相对 wiki 根路径，如 projects/prj-demo-proj.md */
  path: string
  /** GLOSSARY 一源多词条时的全部产物路径（幂等存在性检查用） */
  entryPaths?: string[]
  anchors: Record<string, string>
}

interface MigrationState {
  version: number
  /** 已发放的最大 oct 序号 —— 锚点永不复用计数器 */
  counter: number
  sources: Record<string, SourceState>
}

export interface MigratorOptions {
  db: Database.Database
  org: string
  /** wiki 根覆盖（缺省走 resolveWikiRoot：OCTOPUS_WIKI_DIR > org 路径） */
  rootDir?: string
  /** 现行知识目录覆盖（缺省 ~/.octopus/orgs/{org}/knowledge） */
  knowledgeDir?: string
  /** 历史布局（无 orgs/ 段）覆盖（缺省 ~/.octopus/{org}/knowledge） */
  legacyKnowledgeDir?: string
  /** GLOSSARY-MAP.md 源路径覆盖（缺省 仓库根/CWD 下 GLOSSARY-MAP.md） */
  glossaryMapPath?: string
  git?: GitRunner
  ruleFormJudge?: RuleFormJudge
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex")
}

/** 锚点号 `oct-007` 中的数字；非该形态返回 0。 */
function anchorOrdinal(anchor: string): number {
  const m = /^oct-(\d+)$/.exec(anchor)
  return m ? Number(m[1]) : 0
}

/**
 * 搬运文本脱敏：真实 GLOSSARY-MAP「词条 (Entry)」的定义里用反引号示范了
 * `<!--#oct-001-->` —— 原样进正文会被 RULE_ANCHOR_RE 当成真锚点，触发全库唯一冲突。
 * 在 `<!--` 与 `#` 之间插一个空格：语义仍在（人眼/FTS 都可读），格式律不再命中。
 * 迁移文本一律过这道脱敏，锚点只能由迁移器自己铸造。
 */
function escapeAnchorLiterals(text: string): string {
  return text.replace(/<!--#/g, "<!-- #")
}

export class InitialCompileMigrator {
  private readonly org: string
  private readonly root: string
  private readonly knowledgeDir: string
  private readonly legacyKnowledgeDir: string
  private readonly glossaryMapPath: string
  private readonly compile: WikiCompileService

  constructor(opts: MigratorOptions) {
    this.org = opts.org
    const base = path.join(os.homedir(), ".octopus")
    this.root = opts.rootDir ?? (process.env.OCTOPUS_WIKI_DIR
      ? process.env.OCTOPUS_WIKI_DIR
      : path.join(base, "orgs", opts.org, "knowledge", "wiki"))
    this.knowledgeDir = opts.knowledgeDir ?? path.join(base, "orgs", opts.org, "knowledge")
    this.legacyKnowledgeDir = opts.legacyKnowledgeDir ?? path.join(base, opts.org, "knowledge")
    this.glossaryMapPath = opts.glossaryMapPath ?? path.join(process.cwd(), "GLOSSARY-MAP.md")
    this.compile = new WikiCompileService({
      db: opts.db,
      org: opts.org,
      rootDir: this.root,
      git: opts.git,
      ruleFormJudge: opts.ruleFormJudge,
    })
  }

  get wikiRoot(): string {
    return this.root
  }

  private statePath(): string {
    return path.join(this.root, MIGRATION_DIR, STATE_FILE)
  }

  private loadState(): MigrationState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath(), "utf-8")) as MigrationState
      if (typeof raw.counter !== "number" || typeof raw.sources !== "object") throw new Error("bad state")
      return { version: raw.version ?? 1, counter: raw.counter, sources: raw.sources }
    } catch {
      return { version: 1, counter: 0, sources: {} }
    }
  }

  private saveState(state: MigrationState): void {
    const dir = path.join(this.root, MIGRATION_DIR)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2) + "\n", "utf-8")
  }

  /** 列出现行目录 + 历史目录（兼容读一次：同 relPath 现行优先）的 projects/workflows 源文件。 */
  private listSources(): Array<{ rel: string; absPath: string; origin: "current" | "legacy" }> {
    const out: Array<{ rel: string; absPath: string; origin: "current" | "legacy" }> = []
    const seen = new Set<string>()
    for (const [dir, origin] of [[this.knowledgeDir, "current"], [this.legacyKnowledgeDir, "legacy"]] as const) {
      for (const sub of ["projects", "workflows"]) {
        let names: string[] = []
        try {
          names = fs.readdirSync(path.join(dir, sub)).filter(n => n.endsWith(".md")).sort()
        } catch {
          continue // 目录不存在（测试 fixture 常只有半边）
        }
        for (const name of names) {
          if (name === "user_preference.md" || name === "index.md") continue
          const rel = `${sub}/${name}`
          if (seen.has(rel)) continue
          seen.add(rel)
          out.push({ rel, absPath: path.join(dir, sub, name), origin })
        }
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  async run(): Promise<MigrationReport> {
    const report: MigrationReport = { compiled: [], skipped: [], failed: [], totals: { entries: 0, rules: 0 } }
    ensureWikiSkeleton(this.root)
    const state = this.loadState()

    // 计数器种子：映射表之外，盘上/库内已有锚点也计入 —— 永不复用、永不冲突
    for (const e of scanWikiEntries(this.root)) {
      for (const a of e.anchors) state.counter = Math.max(state.counter, anchorOrdinal(a))
    }

    for (const src of this.listSources()) {
      const raw = fs.readFileSync(src.absPath, "utf-8")
      const hash = sha256(raw)
      const known = state.sources[src.rel]
      if (known && known.hash === hash && fs.existsSync(path.join(this.root, known.path))) {
        report.skipped.push(src.rel)
        continue
      }
      try {
        const res = await this.migrateKnowledgeFile(src.rel, raw, src.origin, state)
        report.compiled.push(res)
      } catch (err) {
        this.recordFailure(report, src.rel, err)
      }
    }

    // GLOSSARY-MAP 系统词条 → business/（prototype Tab③：程序切分 + 人审抽样）
    if (fs.existsSync(this.glossaryMapPath)) {
      const raw = fs.readFileSync(this.glossaryMapPath, "utf-8")
      try {
        const results = await this.migrateGlossary(raw, state)
        if (results === "skipped") report.skipped.push(GLOSSARY_REL)
        else report.compiled.push(...results)
      } catch (err) {
        this.recordFailure(report, GLOSSARY_REL, err)
      }
    }

    report.totals.entries = report.compiled.length
    report.totals.rules = report.compiled.reduce((s, c) => s + c.anchors.length, 0)
    return report
  }

  private recordFailure(report: MigrationReport, source: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    // 票04 AC5：拆分提案入队语义已删——lint 拒写随错误携带**拆分建议**（对话内自纠用），不再入队
    const suggestion = err && typeof err === "object" && "suggestion" in err
      ? (err as { suggestion?: SplitProposal }).suggestion
      : undefined
    report.failed.push({ source, error: msg, splitSuggestion: suggestion })
  }

  /**
   * GLOSSARY-MAP.md System-wide Glossary 表 → business/ 词条，按 Primary Package 首项分组、
   * 组内按 token/规则数双预算切块（块产物过 L1 容量闸，H2 小节 ≤10 规则免 L3 warn）。
   * 一源多词条：映射表键 `glossary:{term}`；幂等 = hash 未变且全部产物在盘。
   */
  private async migrateGlossary(raw: string, state: MigrationState): Promise<MigrationReport["compiled"] | "skipped"> {
    const hash = sha256(raw)
    const terms = parseGlossaryTerms(raw)
    if (terms.length === 0) return "skipped"

    // 分组（按首次出现序）+ 切块（≤GLOSSARY_MAX_RULES 条 且 行估 token ≤GLOSSARY_MAX_TOKENS）
    const groups = new Map<string, GlossaryTerm[]>()
    for (const t of terms) {
      const arr = groups.get(t.group) ?? []
      arr.push(t)
      groups.set(t.group, arr)
    }
    interface Chunk { group: string; idx: number; entryId: string; terms: GlossaryTerm[] }
    const chunks: Chunk[] = []
    for (const [group, list] of groups) {
      let current: GlossaryTerm[] = []
      let tokens = 0
      const slug = `biz-glossary-${sanitizeSlug(group)}`
      const flush = () => {
        if (current.length === 0) return
        const idx = chunks.filter(c => c.group === group).length
        chunks.push({ group, idx, entryId: idx === 0 ? slug : `${slug}-${idx + 1}`, terms: current })
        current = []
        tokens = 0
      }
      for (const t of list) {
        const lineTokens = estimateTokens(`- **${t.term}** — ${t.def}`)
        if (current.length > 0 && (current.length >= GLOSSARY_MAX_RULES || tokens + lineTokens > GLOSSARY_MAX_TOKENS)) flush()
        current.push(t)
        tokens += lineTokens
      }
      flush()
    }

    // 锚点规划先于编译（永不复用：已有映射逐字取回，新术语续排新号）
    const known = state.sources[GLOSSARY_REL]
    const anchorByTerm = new Map<string, string>()
    for (const c of chunks) {
      for (const t of c.terms) {
        const key = `glossary:${t.term}`
        const existing = known?.anchors[key]
        const anchor = existing ?? `oct-${String(state.counter + 1).padStart(3, "0")}`
        if (!existing) state.counter++
        anchorByTerm.set(key, anchor)
      }
    }

    const entryPaths = chunks.map(c => `business/${c.entryId}.md`)
    const changed = known?.hash !== hash
    const missing = entryPaths.filter(p => !fs.existsSync(path.join(this.root, p)))
    if (!changed && missing.length === 0) return "skipped"
    const toCompile = changed ? chunks : chunks.filter(c => entryPaths.indexOf(`business/${c.entryId}.md`) >= 0 && missing.includes(`business/${c.entryId}.md`))

    // 映射表先落盘（首次编译的 git add -A 连同 state 一起 commit，审计同轨）
    state.sources[GLOSSARY_REL] = {
      hash,
      origin: "current",
      entryId: chunks[0]?.entryId ?? "",
      path: entryPaths[0] ?? "",
      entryPaths,
      anchors: Object.fromEntries(anchorByTerm),
    }
    this.saveState(state)

    const out: MigrationReport["compiled"] = []
    for (const c of toCompile) {
      const title = `${c.group} 域术语${c.idx > 0 ? `（${c.idx + 1}）` : ""}`
      const body = `## ${c.group} 术语\n\n${c.terms
        .map(t => `- **${escapeAnchorLiterals(t.term)}** — ${escapeAnchorLiterals(t.def)} <!--#${anchorByTerm.get(`glossary:${t.term}`)}-->`)
        .join("\n")}\n`
      const meta: WikiEntryFrontmatter = {
        id: c.entryId,
        domain: "business",
        title: `术语口径 · ${title}`,
        summary: `GLOSSARY-MAP 存量收编 · ${c.group}`,
        topics: ["glossary", sanitizeSlug(c.group)],
        stability: "stable",
        last_compiled: today(),
        sources: [`doc:${GLOSSARY_REL}`],
        confidence: MIGRATED_CONFIDENCE,
      }
      const result = await this.compile.compileEntry({
        content: serializeEntryMarkdown(meta, body),
        fileName: `${c.entryId}.md`,
        source: `migrate:${GLOSSARY_REL}`,
        note: `初始编译 ${c.group} 术语 ${c.terms.length} 条（${c.entryId}）`,
      })
      out.push({
        source: GLOSSARY_REL,
        entryId: c.entryId,
        path: result.path,
        commit: result.commit,
        anchors: c.terms.map(t => ({ legacy: `glossary:${t.term}`, anchor: anchorByTerm.get(`glossary:${t.term}`)! })),
      })
    }
    return out
  }

  /** 单源文件迁移（旧格式无 front-matter：两行式 + 行内式规则，H2 小节保结构）。锚点映射先落 state 再编译，同 commit 可审。 */
  private async migrateKnowledgeFile(
    rel: string,
    raw: string,
    origin: "current" | "legacy",
    state: MigrationState,
  ): Promise<MigrationReport["compiled"][number]> {
    const sections = this.parseSections(raw)
    const rules = sections.flatMap(s => s.rules)
    if (rules.length === 0) {
      throw new Error(`NO_RULES: ${rel} 未解析出任何规则行（跳过迁移，不留空词条、不登记映射）`)
    }
    const base = path.basename(rel, ".md")
    const entryId = `${rel.startsWith("projects") ? "prj" : "wf"}-${base}`
    const domain = rel.startsWith("projects") ? "projects" : "workflows"

    const known = state.sources[rel]
    const anchors: AnchorPair[] = rules.map(r => {
      const existing = known?.anchors[r.id]
      if (existing) return { legacy: r.id, anchor: existing }
      const anchor = `oct-${String(state.counter + 1).padStart(3, "0")}`
      state.counter++
      return { legacy: r.id, anchor }
    })

    // 收编行内 date/source 注释：唯一 (source,date) 对进 front-matter sources
    const provenance = [...new Set(rules.map(r => `archive:${r.source}@${r.date}`))].sort()
    const sources = [`doc:knowledge/${rel}`, ...provenance]

    const anchorByRule = new Map<LegacyRule, string>()
    rules.forEach((r, i) => anchorByRule.set(r, anchors[i].anchor))
    const body = sections
      .map(s => `## ${s.title ?? "规则"}\n\n${s.rules.map(r => `- ${escapeAnchorLiterals(r.text)} <!--#${anchorByRule.get(r)}-->`).join("\n")}`)
      .join("\n\n") + "\n"
    const meta: WikiEntryFrontmatter = {
      id: entryId,
      domain,
      title: `${base} ${domain === "projects" ? "项目" : "工作流"}知识`,
      summary: `存量迁移 · ${rel}`,
      topics: [base, "migrated"],
      stability: "stable",
      last_compiled: today(),
      sources,
      confidence: MIGRATED_CONFIDENCE,
    }
    const content = serializeEntryMarkdown(meta, body)

    // 映射表先落盘：compileEntry 的 git add -A 会把 state.json 与本词条同一 commit 收编
    const entryPath = `${domain}/${entryId}.md`
    state.sources[rel] = { hash: sha256(raw), origin, entryId, path: entryPath, anchors: Object.fromEntries(anchors.map(a => [a.legacy, a.anchor])) }
    this.saveState(state)

    const result: CompileResult = await this.compile.compileEntry({
      content,
      fileName: `${entryId}.md`,
      source: `migrate:${rel}`,
      note: `初始编译 ${rel} → +${anchors.length} 条规则（${anchors.map(a => a.anchor).join(",")}）`,
    })
    return { source: rel, entryId, path: result.path, commit: result.commit, anchors }
  }

  /**
   * 解析旧格式（两种真实变体，data-plane notes §2）：
   *   (a) 两行式：`- 文本\n<!-- id:X | date | source -->`（注释独占一行）
   *   (b) 行内式：`- 文本 <!-- id:X | date | source -->`（常在 H2 小节下）
   * H2 小节结构保留（拆分提案按 H2 切）；无小节头的规则归入 null 标题（渲染成 `## 规则`）。
   */
  private parseSections(raw: string): LegacySection[] {
    const lines = raw.replace(/\r\n/g, "\n").split("\n")
    const sections: LegacySection[] = []
    let current: LegacySection | null = null
    const ensure = (): LegacySection => {
      if (!current) {
        current = { title: null, rules: [] }
        sections.push(current)
      }
      return current
    }
    const metaRe = /<!-- id:(\S+) \| (\S+) \| (\S+) -->/
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const h2 = /^## (.*\S)\s*$/.exec(line)
      if (h2) {
        current = { title: h2[1].trim(), rules: [] }
        sections.push(current)
        continue
      }
      const m = metaRe.exec(line)
      if (!m) continue
      // 退役标记（markRuleRetired 追加的下一行 `<!-- retired -->`）⇒ 规则不入库、不占锚点号
      if ((lines[i + 1] ?? "").trim() === "<!-- retired -->") continue
      const isOwnCommentLine = line.trim().startsWith("<!--")
      const text = isOwnCommentLine
        ? (i > 0 ? lines[i - 1] : "").replace(/^-\s*/, "").trim()
        : line.replace(metaRe, "").replace(/^-\s*/, "").trim()
      if (!text || metaRe.test(text)) continue
      ensure().rules.push({ id: m[1], date: m[2], source: m[3], text })
    }
    return sections.filter(s => s.rules.length > 0)
  }
}

interface LegacyRule {
  id: string
  date: string
  source: string
  text: string
}

interface LegacySection {
  title: string | null
  rules: LegacyRule[]
}

interface GlossaryTerm {
  term: string
  def: string
  group: string
}

/** 分组键 slug 化（进词条 id/topics/文件名，必须过 kebab 闸）。 */
export function sanitizeSlug(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 32).replace(/-+$/, "")
  return /^[a-z]/.test(slug) ? slug : `g-${slug}`.slice(0, 40)
}

/**
 * 解析 GLOSSARY-MAP「System-wide Glossary」表的三列行 `| **术语** | 定义 | 包 |`。
 * 只认该节（下一 `## ` 前为止）；二列 Anti-Patterns 表无包列自然丢弃。
 *
 * 行切分以「术语锚点」为起点（`\| **term** \|`），行尾段按「最后一个 | 之前是定义、
 * 最后两个 | 之间是包列」切——真实数据两类陷阱的对策（smoke 实测回归）：
 *   ① 粘连行（两条表格行落同一物理行，`||` 分隔）：同一物理行可回收多个术语锚点；
 *   ② 定义含裸管道符（如「INDEX/LOG 导航层」的 LOG 行格式示例 ` |日期|动作|…| `）：
 *      按列数硬切会拦腰截断定义、把管道碎片当分组键。
 * group = 包列首项。术语重名保留首次出现（映射表键唯一性）。
 */
export function parseGlossaryTerms(raw: string): GlossaryTerm[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex(l => /^## System-wide Glossary\s*$/.test(l.trim()))
  if (start === -1) return []
  const out: GlossaryTerm[] = []
  const seen = new Set<string>()
  const termRe = /\|\s*\*\*([^*]+?)\*\*\s*\|/g
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break
    const line = lines[i]
    const starts = [...line.matchAll(termRe)]
    for (let k = 0; k < starts.length; k++) {
      const m = starts[k]
      const spanEnd = k + 1 < starts.length ? starts[k + 1].index : line.length
      let span = line.slice(m.index + m[0].length, spanEnd).trim()
      if (span.endsWith("|")) span = span.slice(0, -1).trim()
      const cut = span.lastIndexOf("|")
      if (cut === -1) continue // 无包列形态（如二列表）：整行丢弃
      const term = m[1].trim()
      const def = span.slice(0, cut).trim()
      const group = sanitizeSlug((span.slice(cut + 1).split(",")[0] ?? "").trim())
      if (!term || !def || !group || seen.has(term)) continue
      seen.add(term)
      out.push({ term, def, group })
    }
  }
  return out
}
