import fs from "fs"
import path from "path"
import { extractRuleAnchors, serializeEntryMarkdown, findDateOccurrences, RULE_ANCHOR_RE } from "./format"
import type { WikiEntryFrontmatter } from "@octopus/shared"

/**
 * wiki lint — 编译期同步闸（票02，spec §增长约束 / prototype Tab③ lines 573-581）。
 *
 * 唯一调用点在 WikiCompileService.compileEntry 的 validate 段——任何写入通道
 * （含票06策展）都过这道闸，无旁路。lint 本身是纯函数（不做 fs/DB 副作用）；
 * 拒写后的拆分提案入队、INDEX 预算回写等副作用归编译服务。
 *
 * 域豁免（票04 cases 接线）：lintProfileForDomain 给出豁免开关——
 * cases 域豁免 L1 容量闸与正文禁日期（判例是历史事件，文件名/正文天然带日期）。
 */

/** 阈值逐字来自 prototype Tab③「增长约束」表（独立真相源）。 */
export const WIKI_LIMITS = {
  ENTRY_MAX_LINES: 120,
  ENTRY_MAX_RULES: 25,
  ENTRY_MAX_TOKENS: 2000,
  HUB_MAX_LINES: 40,
  H2_MAX_RULES: 10,
  INDEX_MAX_TOKENS: 800,
  CODE_BLOCK_MAX_LINES: 20,
} as const

export type LintSeverity = "error" | "warn"
export interface LintFinding {
  level: "L1" | "L3" | "L4" | "L5" | "L6"
  severity: LintSeverity
  /** 稳定 code 前缀（L1_CAPACITY / L5_LINK_BROKEN / …），调用方据此分支 */
  code: string
  message: string
}

/** lint 拒绝写入时抛出：message 带 `L1_CAPACITY:`/`L5_*:` 等稳定 code 前缀。 */
export class WikiLintError extends Error {
  readonly findings: LintFinding[]
  proposalId?: string
  constructor(code: string, message: string, findings: LintFinding[]) {
    super(`${code}: ${message}`)
    this.name = "WikiLintError"
    this.findings = findings
  }
}

/**
 * token 估算（无 tiktoken 依赖的确定性启发式，与闸的 ~2000/800 预算同口径）：
 * 每个 CJK 字符 ≈ 1 token，其余字符 4 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[㐀-䶿一-鿿぀-ヿ가-힯＀-￯]/.test(ch)) cjk++
    else if (!/\s/.test(ch)) other++
  }
  return cjk + Math.ceil(other / 4)
}

export interface H2Section {
  title: string
  lines: string[]
  anchors: string[]
}

export interface SectionedBody {
  /** 第一个 `## ` 之前的所有行（H1/引言/无小节规则） */
  preamble: string[]
  sections: H2Section[]
}

/** 按 `## ` 切分正文；`###` 及更深归所在 H2 小节。 */
export function parseH2Sections(body: string): SectionedBody {
  const lines = body.replace(/\r\n/g, "\n").split("\n")
  const preamble: string[] = []
  const sections: H2Section[] = []
  let current: H2Section | null = null
  for (const line of lines) {
    const m = /^## (.*\S)\s*$/.exec(line)
    if (m) {
      current = { title: m[1].trim(), lines: [], anchors: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  for (const s of sections) s.anchors = extractRuleAnchors(s.lines.join("\n"))
  return { preamble, sections }
}

/** 域 → lint 豁免开关（票04 cases 在此收口，编译服务按 meta.domain 应用）。 */
export interface LintProfile {
  /** 豁免 L1 容量闸（cases 判例天然长、带日期） */
  capacity: boolean
  /** 豁免 L5 正文禁日期 */
  datesInBody: boolean
}
export function lintProfileForDomain(domain: string): LintProfile {
  if (domain === "cases") return { capacity: false, datesInBody: false }
  return { capacity: true, datesInBody: true }
}

/** `[[target]]` / `[[target#anchor]]` / `[[target|别名]]`（Obsidian 惯例）。 */
export const WIKILINK_RE = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g

/**
 * [[wikilink]] 目标解析：路径式（含/不含 .md、目录→README 的 hub 形态）或裸 id 式。
 * corpus = 全库已有词条 {id, path} + 本次待写词条自身。
 * fs 存在性以 wiki 根为准（票01 纪律：真源在盘）。
 */
export function resolveWikiLink(
  target: string,
  root: string,
  corpus: Array<{ id: string; path: string }>,
): boolean {
  const t = target.trim().replace(/\/+$/, "")
  const abs = (p: string) => path.resolve(root, p)
  const inRoot = (p: string) => {
    const a = abs(p)
    return a.startsWith(path.resolve(root) + path.sep) && fs.existsSync(a)
  }
  if (t.endsWith(".md")) return inRoot(t)
  if (inRoot(`${t}.md`) || inRoot(path.join(t, "README.md")) || inRoot(t)) return true
  const bare = t.split("/").pop() ?? t
  return corpus.some(e => e.id === bare && (!t.includes("/") || e.path === `${t}.md` || e.path.startsWith(`${t}/`)))
}

export interface LintInput {
  meta: WikiEntryFrontmatter
  body: string
  anchors: string[]
  /** wiki 根（[[wikilink]] 目标文件存在性判定） */
  root: string
  /** 链接语料：全库词条 {id, path}（含本次自身） */
  linkCorpus: Array<{ id: string; path: string }>
  /** 省略时按 meta.domain 自动取（cases 豁免） */
  profile?: LintProfile
}

export interface LintResult {
  errors: LintFinding[]
  warnings: LintFinding[]
}

/** 正文 >N 行代码块巡检：返回超限块的行数列表。 */
export function overLongCodeBlocks(body: string, maxLines: number): number[] {
  const offenders: number[] = []
  const lines = body.split("\n")
  let inBlock = false
  let count = 0
  for (const line of lines) {
    if (/^\s{0,3}```/.test(line)) {
      if (inBlock) {
        if (count > maxLines) offenders.push(count)
        inBlock = false
        count = 0
      } else {
        inBlock = true
        count = 0
      }
      continue
    }
    if (inBlock) count++
  }
  if (inBlock && count > maxLines) offenders.push(count) // 未闭合块也计入
  return offenders
}

/**
 * 同步闸主体（票02：L1/L3/L5；L4 在 INDEX 渲染处收口，L6 走 judgeRuleForms）。
 * L1 先到为准按 行→规则→token 顺序报第一个超限项。
 */
export function lintWikiEntry(input: LintInput): LintResult {
  const { meta, body, anchors } = input
  const profile = input.profile ?? lintProfileForDomain(meta.domain)
  const errors: LintFinding[] = []
  const warnings: LintFinding[] = []

  // ── L1 词条容量闸：≤120 行 / 25 条规则 / ~2000 token，先到为准 ──
  if (profile.capacity) {
    const serialized = serializeEntryMarkdown(meta, body).replace(/\n+$/, "")
    const fileLines = serialized.split("\n").length
    const tokens = estimateTokens(serialized)
    if (fileLines > WIKI_LIMITS.ENTRY_MAX_LINES) {
      errors.push({ level: "L1", severity: "error", code: "L1_CAPACITY", message: `词条 ${fileLines} 行超过容量闸 ${WIKI_LIMITS.ENTRY_MAX_LINES} 行（先到为准）` })
    } else if (anchors.length > WIKI_LIMITS.ENTRY_MAX_RULES) {
      errors.push({ level: "L1", severity: "error", code: "L1_CAPACITY", message: `词条 ${anchors.length} 条规则超过容量闸 ${WIKI_LIMITS.ENTRY_MAX_RULES} 条（先到为准）` })
    } else if (tokens > WIKI_LIMITS.ENTRY_MAX_TOKENS) {
      errors.push({ level: "L1", severity: "error", code: "L1_CAPACITY", message: `词条约 ${tokens} token 超过容量闸约 ${WIKI_LIMITS.ENTRY_MAX_TOKENS} token（先到为准）` })
    }
  }

  // ── L3 小节容量：单 H2 ≤10 条规则 → warn（不阻塞）──
  const { sections } = parseH2Sections(body)
  for (const s of sections) {
    if (s.anchors.length > WIKI_LIMITS.H2_MAX_RULES) {
      warnings.push({ level: "L3", severity: "warn", code: "L3_SECTION", message: `L3: H2 小节「${s.title}」有 ${s.anchors.length} 条规则 > ${WIKI_LIMITS.H2_MAX_RULES}，建议独立成子词条（不阻塞）` })
    }
  }

  // ── L5 断链：[[wikilink]] 目标必须存在；可被 INDEX 程序化重建自动修复的（仅缺席索引）不打扰人 ──
  const broken: string[] = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim()
    if (target && !resolveWikiLink(target, input.root, input.linkCorpus)) broken.push(target)
  }
  if (broken.length > 0) {
    errors.push({ level: "L5", severity: "error", code: "L5_LINK_BROKEN", message: `断链 [[...]] 目标不存在: ${broken.map(b => `[[${b}]]`).join(", ")}` })
  }

  // ── L5 正文禁日期（cases 豁免）；日期只出现在 [[...]] 链接内（判例文件名天然带日期）不算 ──
  if (profile.datesInBody) {
    const dates = findDateOccurrences(body.replace(WIKILINK_RE, ""))
    if (dates.length > 0) {
      errors.push({ level: "L5", severity: "error", code: "L5_DATES_IN_BODY", message: `正文出现日期 ${dates.map(d => `'${d}'`).join(", ")}——常青正文应零日期（日期由 front-matter sources / LOG.md / git history 三处承接）` })
    }
  }

  // ── L5 禁 >20 行代码块（长内容指回源指针，原型纪律）──
  const longBlocks = overLongCodeBlocks(body, WIKI_LIMITS.CODE_BLOCK_MAX_LINES)
  if (longBlocks.length > 0) {
    errors.push({ level: "L5", severity: "error", code: "L5_CODE_BLOCK", message: `代码块 ${longBlocks.join("/")} 行超过 ${WIKI_LIMITS.CODE_BLOCK_MAX_LINES} 行上限——长内容应指回源码/docs 指针` })
  }

  return { errors, warnings }
}

// ── L6 规则形态：祈使句/事实陈述判定（编译时 LLM，非 regex；warn 级）────────
// 判定本体由注入的 judge 完成——单测一律 fixture-mocked（spec Testing Decisions：
// 不连真模型），生产侧票06 用 knowledge/llm 的 LLMCall 包一个适配器。

export interface RuleFormIssue {
  anchor: string
  /** 祈使化改写稿（原型逐字例："implement 通常 30min" → "按 ≥30min 规划预算"） */
  suggestion: string
}

export type RuleFormJudge = (rules: Array<{ anchor: string; text: string }>) => Promise<RuleFormIssue[]>

/** 规则行抽取：带锚点的行（剥离 `<!--#id-->` 注释后的原文）。 */
export function ruleLinesForFormCheck(body: string): Array<{ anchor: string; text: string }> {
  const out: Array<{ anchor: string; text: string }> = []
  for (const line of body.split("\n")) {
    const m = RULE_ANCHOR_RE.exec(line)
    if (m) out.push({ anchor: m[1], text: line.replace(/<!--#[A-Za-z0-9_-]+-->/g, "").trim() })
  }
  return out
}

/** L6 判定：judge 返回的描述句 → warn findings（不阻塞）。 */
export async function judgeRuleForms(body: string, judge: RuleFormJudge): Promise<LintFinding[]> {
  const rules = ruleLinesForFormCheck(body)
  if (rules.length === 0) return []
  let issues: RuleFormIssue[]
  try {
    issues = await judge(rules)
  } catch {
    return [] // 判定失败绝不阻塞编译（warn 级纪律）
  }
  return issues.map(i => ({
    level: "L6" as const,
    severity: "warn" as const,
    code: "L6_RULE_FORM",
    message: `L6: 规则 '${i.anchor}' 为描述句——建议改写为祈使/事实陈述：「${i.suggestion}」（不阻塞）`,
  }))
}

// ── 拆分提案（L1 触顶自动生成，按 H2 小节切）──────────────────────

export interface SplitProposalChild {
  slug: string
  title: string
  anchors: string[]
  ruleCount: number
}

export interface SplitProposal {
  kind: "wiki-split"
  entryId: string
  domain: string
  /** 拆分前词条的相对路径 */
  path: string
  reason: string
  /** hub 目录形态：原文件 → domain/{base}/README.md */
  hubPath: string
  children: SplitProposalChild[]
}

/** H2 标题 → 子词条文件名 slug（ASCII 词元优先；无则 part-N）。 */
export function slugifySection(title: string, index: number): string {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "")
  return /^[a-z0-9][a-z0-9-]*$/.test(ascii) && ascii.length >= 2 ? ascii : `part-${index + 1}`
}

/** 为文件路径 `projects/prj-big.md` 生成按 H2 的拆分计划（纯函数，可入队可审计）。 */
export function buildSplitProposal(meta: WikiEntryFrontmatter, fileName: string, body: string, reason: string): SplitProposal {
  const base = fileName.replace(/\.md$/i, "")
  const { sections } = parseH2Sections(body)
  return {
    kind: "wiki-split",
    entryId: meta.id,
    domain: meta.domain,
    path: `${meta.domain}/${fileName}`,
    reason,
    hubPath: `${meta.domain}/${base}/README.md`,
    children: sections.map((s, i) => ({
      slug: slugifySection(s.title, i),
      title: s.title,
      anchors: s.anchors,
      ruleCount: s.anchors.length,
    })),
  }
}
