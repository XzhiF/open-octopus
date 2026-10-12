import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter } from "@octopus/shared"
import { parseEntryMarkdown, serializeEntryMarkdown, extractRuleAnchors } from "./format"
import { resolveWikiRoot, type WikiDomainDir } from "./paths"
import type { GitRunner } from "./wiki-git"
import { scanWikiEntries, WikiCompileService, WIKI_LOG_FILE, WIKI_LOG_HEADER, formatLogRow } from "./compile"
import { parseH2Sections, type RuleFormJudge } from "./lint"
import type { PendingReviewRow } from "../../../db/dao/pending-review-dao"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"

/**
 * WikiCurateService — 策展人编译通道（票06，spec D4 写入单一闸门的"审核→编译"段）。
 *
 * 审核队列 approve（type 'rule' / 'wiki-edit'）后由本服务执行：
 *   合并近义规则 → 更新目标词条小节 → 冲突三型复核（contradicts/overlaps/supersedes）
 *   → `await compileEntry`（票01 唯一写入口 + 票02 lint 闸 + LOG/INDEX/FTS/git commit）。
 *
 * 编译 ≠ 追加：这里没有 appendFile 旁路——一切落盘都走 WikiCompileService。
 * user_preference.md 永不进入自动写路径：本通道对它直接拒绝（只出"AI 辅助建议"，
 * 改写必须人工，与仓库 no-auto-write-user-files 纪律一致）。
 * supersedes 时旧规则行迁入 `_retired/<anchor>.md`（带 replaced_by 指针，可追溯）。
 */

export type ConflictType = "contradicts" | "overlaps" | "supersedes"

export interface CurateConflict {
  type: ConflictType
  anchor: string
  note: string
}

export interface CurateResult {
  entryId: string
  /** 相对 wiki 根的 POSIX 路径 */
  path: string
  /** added = 新规则行；merged = 近义重复并入现行规则（不双写） */
  action: "added" | "merged"
  /** added 时新生成的锚点 */
  anchor?: string
  /** merged 时并入的现行锚点 */
  mergedInto?: string
  commit: string | null
  warnings: string[]
  /** 编译时复核出的冲突（prototype 冲突检测三型；supersedes 已执行迁退役区） */
  conflicts: CurateConflict[]
}

/** 规则条目正文：纯文本，或 JSON 草案 {text, section}（策展人对话/票12 可带小节）。 */
interface RuleDraft {
  text: string
  section?: string
}

/** wiki 词条形态的 target_file（域目录 + .md）；非此形态属旧注入轨道，不进场。 */
const WIKI_TARGET_RE = /^(projects|workflows|business|research|cases)\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.md$/i

/** 无显式小节时的默认策展小节（常青标题，零日期）。 */
const DEFAULT_SECTION = "策展增补"

export function isWikiTarget(targetFile?: string | null): boolean {
  return !!targetFile && WIKI_TARGET_RE.test(targetFile)
}

/**
 * user_preference.md 写保护判定（basename 级，任何路径形态都拦）。
 * 蓝图/prototype 双钉：`⚙ user_preference 手动` + 永不自动改写。
 */
export function isUserPreferencePath(p?: string | null): boolean {
  if (!p) return false
  const base = p.replace(/\\/g, "/").split("/").pop() ?? ""
  return base.toLowerCase() === "user_preference.md"
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 归一化规则文本用于近义判定：去行首 bullet、去锚点注释、markdown 记号、标点与空白，小写。 */
export function normalizeRuleText(text: string): string {
  return text
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/<!--#[A-Za-z0-9_-]+-->/g, "")
    .replace(/[`*_~[\]()（）【】：:;,.!！?？"'，。、·—→｜|\\/#{}<>]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
}

/** token 集合（ASCII 词元 + CJK 二元组）——overlaps/contradicts 的重叠度度量基底。 */
export function ruleTokens(text: string): Set<string> {
  const norm = normalizeRuleText(text)
  const out = new Set<string>()
  for (const m of norm.matchAll(/[a-z0-9]+/g)) out.add(m[0])
  const cjk = norm.replace(/[^\p{Script=Han}]/gu, "")
  for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** 否定极性（contradicts 复核用：同一话题、极性相反）。 */
const NEGATION_RE = /(不得|禁止|不要|不能|不可|勿|严禁|⛔|never|cannot|don't|do not|avoid)/i
function polarity(text: string): 1 | -1 {
  return NEGATION_RE.test(text) ? -1 : 1
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

/** 域 → 词条 id 前缀（prototype：prj-octopus / wf-prd-impl / sop-…均小写 kebab）。 */
const DOMAIN_ID_PREFIX: Record<WikiDomainDir, string> = {
  projects: "prj",
  workflows: "wf",
  business: "biz",
  research: "res",
  cases: "case",
}

/**
 * 把一行规则插进 H2 小节（存在则追加到该节最后一条规则后；不存在则新开小节）。
 * 纯字符串手术——产物仍过 compileEntry 的 lint 闸，不旁路。
 */
export function appendRuleLine(body: string, section: string, ruleLine: string): string {
  const trimmed = body.replace(/\s+$/, "")
  if (trimmed.length === 0) return `## ${section}\n${ruleLine}\n`
  const m = new RegExp(`^## ${escapeRe(section)}\\s*$`, "m").exec(trimmed)
  if (!m) return `${trimmed}\n\n## ${section}\n${ruleLine}\n`
  const start = m.index + m[0].length + 1
  const rest = trimmed.slice(start)
  const nextIdx = rest.search(/^## /m)
  if (nextIdx === -1) return `${trimmed}\n${ruleLine}\n`
  return `${trimmed.slice(0, start)}${rest.slice(0, nextIdx).replace(/\s+$/, "")}\n${ruleLine}\n\n${rest.slice(nextIdx)}`
}

/** 删除锚点所在规则行（supersedes 迁出用）；返回新正文 + 被删行原文。 */
export function removeRuleLineByAnchor(body: string, anchor: string): { body: string; removedLine: string | null } {
  const lines = body.split("\n")
  const idx = lines.findIndex(l => l.includes(`<!--#${anchor}-->`))
  if (idx === -1) return { body, removedLine: null }
  const removedLine = lines[idx]
  lines.splice(idx, 1)
  return { body: lines.join("\n"), removedLine }
}

export class WikiCurateService {
  private readonly db: Database.Database
  private readonly org: string
  private readonly root: string
  private readonly compiler: WikiCompileService
  private readonly articles: WikiArticleDAO

  constructor(opts: { db: Database.Database; org: string; rootDir?: string; git?: GitRunner; ruleFormJudge?: RuleFormJudge }) {
    this.db = opts.db
    this.org = opts.org
    this.root = resolveWikiRoot(opts.org, opts.rootDir)
    this.compiler = new WikiCompileService({ ...opts, rootDir: this.root })
    this.articles = new WikiArticleDAO(opts.db)
  }

  get wikiRoot(): string {
    return this.root
  }

  /** 审核通过条目的策展入口（ReviewService.approveItem 分发到这里）。 */
  async applyApprovedItem(item: PendingReviewRow): Promise<CurateResult> {
    if (isUserPreferencePath(item.target_file)) {
      throw new Error(`CURATE_REFUSED_USER_PREFERENCE: user_preference.md 永不进入自动写路径（策展通道只出建议，改写须人工）`)
    }
    switch (item.type) {
      case "rule":
        return this.applyRule(item)
      case "wiki-edit":
        return this.applyWikiEdit(item)
      default:
        throw new Error(`CURATE_UNSUPPORTED_TYPE: '${item.type}' 不在策展编译通道（rule|wiki-edit）`)
    }
  }

  /**
   * 「AI 辅助编辑建议 → 人确认」形态（票06 写权保护的唯一出口）：
   * 对 user_preference.md 的队列条目只产出一份纯文本建议（含 diff 预览与
   * 确认指引），零 fs/DB/git 副作用——人工确认后由人手动落笔。
   */
  static preferenceEditSuggestion(item: PendingReviewRow): string {
    const raw = (item.content ?? "").trim()
    let text = raw
    try {
      const parsed = JSON.parse(raw) as { text?: unknown }
      if (typeof parsed.text === "string") text = parsed.text
    } catch { /* 纯文本条目 */ }
    return [
      `# user_preference.md 编辑建议（审核 ${item.id}）`,
      "",
      `> 本建议由策展通道生成——user_preference.md 不自动改写，须人工确认后手动编辑。`,
      "",
      `## 建议内容`,
      `- ${clip(text, 200)}`,
      "",
      `## 人工确认步骤`,
      `1. 打开 \`~/.octopus/orgs/{org}/knowledge/wiki/user_preference.md\` 核对上下文`,
      `2. 同意则以 manual 通道提交：\`OCTOPUS_WIKI_COMMIT_SOURCE=manual git commit\``,
      `3. 在审核队列对本条目写 user_notes 记录「已人工采纳/拒绝」`,
    ].join("\n")
  }

  /**
   * [规则] 采纳：合并进目标词条（近义重复不双写），新规则行取全库下一个
   * `oct-NNN` 锚点（永不复用），经 compileEntry 落 git commit（message 带 [review:id]）。
   */
  private async applyRule(item: PendingReviewRow): Promise<CurateResult> {
    const draft = this.parseRuleDraft(item)
    if (!isWikiTarget(item.target_file)) {
      throw new Error(`CURATE_NOT_WIKI_TARGET: '${item.target_file ?? ""}' 不是 wiki 词条路径（域目录 + .md）`)
    }
    const relPath = item.target_file.replace(/\\/g, "/")
    const [domain, ...restSegments] = relPath.split("/")
    const fileName = restSegments.join("/")
    const abs = path.resolve(this.root, relPath)

    const curateResult: CurateResult = {
      entryId: "",
      path: relPath,
      action: "added",
      commit: null,
      warnings: [],
      conflicts: [],
    }

    let meta: WikiEntryFrontmatter
    let body: string
    if (fs.existsSync(abs)) {
      const parsed = parseEntryMarkdown(fs.readFileSync(abs, "utf-8"))
      meta = parsed.meta
      body = parsed.body
    } else {
      meta = this.freshMeta(domain as WikiDomainDir, fileName, item, draft.text)
      body = ""
    }
    curateResult.entryId = meta.id

    // ── 合并近义规则（prototype 编译流水线④「合并近义」）：
    //    归一化全等 = 同一规则 → 并入现行锚点，不双写、不产生空提交 ──
    const normNew = normalizeRuleText(draft.text)
    for (const existing of this.ruleLinesWithAnchors(body)) {
      if (normalizeRuleText(existing.text) === normNew) {
        return { ...curateResult, action: "merged", mergedInto: existing.anchor }
      }
    }

    // ── 冲突三型编译时复核（蓝图保留）：overlaps 提示合并；contradicts 极性相反警示。
    //    人工已在队列裁决 → 记入结果与 warnings，不阻断（阻断归审核面，不归写面）。──
    const newTokens = ruleTokens(draft.text)
    for (const existing of this.ruleLinesWithAnchors(body)) {
      const sim = jaccard(newTokens, ruleTokens(existing.text))
      if (sim >= 0.5 && polarity(existing.text) !== polarity(draft.text)) {
        curateResult.conflicts.push({ type: "contradicts", anchor: existing.anchor, note: `与现行规则 '${existing.anchor}' 同话题极性相反（Jaccard ${sim.toFixed(2)}）` })
      } else if (sim >= 0.5) {
        curateResult.conflicts.push({ type: "overlaps", anchor: existing.anchor, note: `与现行规则 '${existing.anchor}' 部分重叠（Jaccard ${sim.toFixed(2)}），建议后续合并` })
      }
    }

    const anchor = this.nextAnchor()
    const section = draft.section ?? DEFAULT_SECTION
    const newBody = appendRuleLine(body, section, `- ${draft.text} <!--#${anchor}-->`)

    meta = {
      ...meta,
      last_compiled: today(),
      sources: [...new Set([...meta.sources, `review:${item.id}`])],
    }
    curateResult.anchor = anchor

    const compiled = await this.compiler.compileEntry({
      content: serializeEntryMarkdown(meta, newBody),
      fileName,
      source: item.source_ref ? `${item.source_ref} ${clip(item.source_label, 20)}`.trim() : item.source_label || item.source,
      reviewer: "curator",
      note: `+${anchor} ${clip(draft.text, 40)}`,
      reviewRef: item.id,
    })
    curateResult.commit = compiled.commit
    curateResult.warnings.push(...compiled.warnings)
    return curateResult
  }

  /**
   * [词条修订]（wiki-edit）采纳 —— 冲突三型之 supersedes 的执行面：
   * 旧规则行迁 `_retired/<anchor>.md`（replaced_by 指针 + 溯源审核条目），
   * 修订稿以新锚点（永不复用旧号）入同一小节；retire 与 compile 同一个
   * commit（compileEntry 的 `git add -A` 收编退役文件与 LOG retire 行）。
   * 中途失败走补偿回滚（LOG 快照还原 + 退役文件清除），不留半退役形态。
   */
  private async applyWikiEdit(item: PendingReviewRow): Promise<CurateResult> {
    const payload = this.parseWikiEditPayload(item)
    if (isUserPreferencePath(payload.path)) {
      throw new Error(`CURATE_REFUSED_USER_PREFERENCE: user_preference.md 永不进入自动写路径（修订建议须人工确认）`)
    }
    if (!isWikiTarget(payload.path)) {
      throw new Error(`CURATE_NOT_WIKI_TARGET: '${payload.path}' 不是 wiki 词条路径（域目录 + .md）`)
    }
    const relPath = payload.path.replace(/\\/g, "/")
    const [domain, ...restSegments] = relPath.split("/")
    const fileName = restSegments.join("/")
    const abs = path.resolve(this.root, relPath)
    if (!fs.existsSync(abs)) {
      throw new Error(`CURATE_TARGET_MISSING: 修订目标 '${relPath}' 不在盘上（存量词条由票05 迁移产出）`)
    }

    const { meta, body } = parseEntryMarkdown(fs.readFileSync(abs, "utf-8"))
    const supersedes = payload.supersedes && payload.supersedes.length > 0
      ? payload.supersedes
      : payload.replace ? [payload.replace.anchor] : []
    if (supersedes.length === 0 && !payload.addRule) {
      throw new Error("CURATE_EMPTY_EDIT: wiki-edit 需至少携带 replace/supersedes/addRule 之一")
    }

    // 复核：被 supersede 的锚点必须真实存在于目标词条（队列里的过期稿不允许带病入库）
    const anchorSet = new Set(extractRuleAnchors(body))
    for (const a of supersedes) {
      if (!anchorSet.has(a)) {
        throw new Error(`CURATE_SUPERSEDE_TARGET_MISSING: '${relPath}' 不含锚点 ${a}（提案与盘上现状脱节，退回队列）`)
      }
    }

    const newAnchor = payload.replace ? this.nextAnchor() : undefined
    const replacedBy = newAnchor ?? "—"

    // ── 正文手术：退役行移除 + 修订稿入原小节 ──
    let newBody = body
    const removed: Array<{ anchor: string; line: string }> = []
    for (const a of supersedes) {
      const { body: after, removedLine } = removeRuleLineByAnchor(newBody, a)
      if (removedLine === null) continue
      removed.push({ anchor: a, line: removedLine })
      newBody = after
    }
    if (payload.replace) {
      const section = sectionTitleForAnchor(body, payload.replace.anchor) ?? DEFAULT_SECTION
      newBody = appendRuleLine(newBody, section, `- ${payload.replace.text} <!--#${newAnchor}-->`)
    } else if (payload.addRule) {
      const section = payload.section ?? DEFAULT_SECTION
      const anchor = this.nextAnchor()
      newBody = appendRuleLine(newBody, section, `- ${payload.addRule} <!--#${anchor}-->`)
    }

    // ── 前置快照（补偿用）──
    const logPath = path.join(this.root, WIKI_LOG_FILE)
    const prevLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : null
    const writtenRetired: string[] = []

    try {
      // 1) _retired/<anchor>.md：原文可追溯 + replaced_by 指针 + 溯源
      fs.mkdirSync(path.join(this.root, WIKI_RETIRE_DIR), { recursive: true })
      for (const r of removed) {
        const retiredAbs = path.join(this.root, WIKI_RETIRE_DIR, `${r.anchor}.md`)
        fs.writeFileSync(retiredAbs, [
          "---",
          `retired: ${r.anchor}`,
          `replaced_by: ${replacedBy}`,
          `retired_on: ${today()}`,
          `source_review: ${item.id}`,
          `source: ${item.source_ref || item.source}`,
          "---",
          "",
          r.line.trim(),
          "",
        ].join("\n"), "utf-8")
        writtenRetired.push(retiredAbs)
      }

      // 2) LOG retire 行（append-only；compile 行由 compileEntry 随后追加，同 commit）
      if (removed.length > 0) {
        const logBase = prevLog ?? WIKI_LOG_HEADER
        const retireRows = removed
          .map(r => formatLogRow({
            action: "retire",
            entry: `${r.anchor} → ${WIKI_RETIRE_DIR}/`,
            note: supersedes.includes(r.anchor) ? `supersedes: replaced_by ${replacedBy}` : `replaced_by ${replacedBy}`,
            source: item.source_ref ? `${item.source_ref} ${clip(item.source_label, 20)}`.trim() : item.source_label || item.source,
            reviewer: "curator",
          }))
          .join("")
        fs.writeFileSync(logPath, logBase + retireRows, "utf-8")
      }

      // 3) 修订稿过唯一写入口（票01）+ lint 闸（票02），commit 带审核引用
      const updatedMeta: WikiEntryFrontmatter = {
        ...meta,
        domain: domain as WikiDomainDir,
        last_compiled: today(),
        sources: [...new Set([...meta.sources, `review:${item.id}`])],
      }
      const note = newAnchor
        ? `+${newAnchor} ${clip(payload.replace!.text, 40)}`
        : `- ${removed.map(r => r.anchor).join("/")} retired`
      const compiled = await this.compiler.compileEntry({
        content: serializeEntryMarkdown(updatedMeta, newBody),
        fileName,
        source: item.source_ref ? `${item.source_ref} ${clip(item.source_label, 20)}`.trim() : item.source_label || item.source,
        reviewer: "curator",
        note,
        reviewRef: item.id,
      })

      const conflicts: CurateConflict[] = removed.map(r => ({
        type: "supersedes" as const,
        anchor: r.anchor,
        note: `已迁 ${WIKI_RETIRE_DIR}/${r.anchor}.md，replaced_by ${replacedBy}`,
      }))
      return {
        entryId: meta.id,
        path: relPath,
        action: newAnchor ? "added" : "merged",
        anchor: newAnchor,
        commit: compiled.commit,
        warnings: [...compiled.warnings],
        conflicts,
      }
    } catch (err) {
      // 补偿：退役文件清除 + LOG 回到本次修订前（compileEntry 自身已回滚词条/INDEX/DB）
      for (const f of writtenRetired) {
        try { fs.rmSync(f, { force: true }) } catch { /* best effort */ }
      }
      if (prevLog === null) {
        try { fs.rmSync(logPath, { force: true }) } catch { /* best effort */ }
      } else {
        try { fs.writeFileSync(logPath, prevLog, "utf-8") } catch { /* best effort */ }
      }
      throw err
    }
  }

  private parseWikiEditPayload(item: PendingReviewRow): {
    path: string
    replace?: { anchor: string; text: string }
    supersedes?: string[]
    addRule?: string
    section?: string
  } {
    let parsed: unknown
    try {
      parsed = JSON.parse(item.content)
    } catch {
      throw new Error("CURATE_BAD_PAYLOAD: wiki-edit content 必须是 JSON 修订草案")
    }
    const p = parsed as {
      kind?: unknown; path?: unknown;
      replace?: { anchor?: unknown; text?: unknown };
      supersedes?: unknown; addRule?: unknown; section?: unknown
    }
    if (!p || p.kind !== "wiki-edit" || typeof p.path !== "string") {
      throw new Error("CURATE_BAD_PAYLOAD: 期望 {kind:'wiki-edit', path, replace?/supersedes?/addRule?}")
    }
    const replace = p.replace && typeof p.replace.anchor === "string" && typeof p.replace.text === "string"
      ? { anchor: p.replace.anchor, text: p.replace.text }
      : undefined
    return {
      path: p.path,
      replace,
      supersedes: Array.isArray(p.supersedes) ? p.supersedes.filter((x): x is string => typeof x === "string") : undefined,
      addRule: typeof p.addRule === "string" ? p.addRule : undefined,
      section: typeof p.section === "string" ? p.section : undefined,
    }
  }

  private parseRuleDraft(item: PendingReviewRow): RuleDraft {
    const raw = (item.content ?? "").trim()
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as { kind?: unknown; text?: unknown; section?: unknown }
        if (typeof parsed.text === "string" && parsed.text.trim().length > 0) {
          return { text: parsed.text.trim(), section: typeof parsed.section === "string" && parsed.section.trim() ? parsed.section.trim() : undefined }
        }
      } catch { /* 落到纯文本解释 */ }
    }
    return { text: raw }
  }

  private freshMeta(domain: WikiDomainDir, fileName: string, item: PendingReviewRow, ruleText: string): WikiEntryFrontmatter {
    const base = fileName.split("/").pop()!.replace(/\.md$/i, "")
    const id = `${DOMAIN_ID_PREFIX[domain]}-${base}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    return {
      id,
      domain,
      title: clip(item.source_label || base, 60),
      summary: clip(ruleText, 60),
      topics: [],
      stability: "stable",
      last_compiled: today(),
      sources: [`review:${item.id}`],
      confidence: item.confidence,
    }
  }

  /** 词条正文里带锚点的规则行（文本已剥锚点注释）。 */
  private ruleLinesWithAnchors(body: string): Array<{ anchor: string; text: string }> {
    const out: Array<{ anchor: string; text: string }> = []
    for (const line of body.split("\n")) {
      const m = /<!--#([A-Za-z0-9_-]+)-->/.exec(line)
      if (m) out.push({ anchor: m[1], text: line.replace(/<!--#[A-Za-z0-9_-]+-->/g, "").trim() })
    }
    return out
  }

  /**
   * 下一个 `oct-NNN` 锚点：盘上词条 + DB 行取最大 +1（全库唯一、永不复用——
   * _retired/ 不在 scan 范围，但迁移出的旧锚点仍存在于历史 DB 快照，
   * 故同时扫 wiki_articles；supersedes 不回收旧 id，新规则永远拿新号）。
   */
  private nextAnchor(): string {
    const used = new Set<string>()
    for (const e of scanWikiEntries(this.root)) for (const a of e.anchors) used.add(a)
    for (const row of this.articles.listByOrg(this.org)) for (const a of extractRuleAnchors(row.body)) used.add(a)
    let max = 0
    for (const a of used) {
      const m = /^oct-(\d+)$/.exec(a)
      if (m) max = Math.max(max, Number(m[1]))
    }
    return `oct-${String(max + 1).padStart(3, "0")}`
  }
}

/** 锚点所在 H2 小节标题（修订稿回填原小节用）；不在任何小节 → undefined。 */
function sectionTitleForAnchor(body: string, anchor: string): string | undefined {
  for (const s of parseH2Sections(body).sections) {
    if (s.anchors.includes(anchor)) return s.title
  }
  return undefined
}

/** 退役区目录名（supersedes 迁入处；scan 不含它，退役锚点不再参与容量/断链统计）。 */
export const WIKI_RETIRE_DIR = "_retired"
