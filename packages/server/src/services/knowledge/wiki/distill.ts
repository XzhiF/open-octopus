import type Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter } from "@octopus/shared"
import { PendingReviewDAO } from "../../../db/dao/pending-review-dao"
import { extractRuleAnchors, serializeEntryMarkdown } from "./format"
import { lintWikiEntry, parseH2Sections } from "./lint"
import { ensureWikiSkeleton, resolveWikiRoot } from "./paths"
import { today } from "./util"

/**
 * 蒸馏迁移（票07，spec §初始编译 蒸馏行 / prototype Tab③ lines 625-626）：
 * docs/research/* → research/ 域候选词条（结论 + 决策依据 + 来源指针 三段式），
 * docs/adr/* → business/ 域决策词条（决策 + 理由 + 指针）。
 *
 * 候选只入审核队列（pending_review，source 标记 distill-migration），**零直接写盘**——
 * 采纳经票06 ReviewService.approveItem → 策展编译通道（wiki-edit createEntry 载荷），
 * 拒绝项留档不写入。原文正文零改动（docs 只读，留档即权威）。
 *
 * 蒸馏器 = 注入式 seam（RuleFormJudge 同法，handoff-02）：ctor `summarizer`，
 * 单测一律 fixture-mocked（不打真模型）；生产侧 index.ts 用 knowledge/llm 的
 * LLMCall 包 createLLMDistillSummarizer 适配器（离线兜底走启发式提取）。
 *
 * 幂等：行 id 内嵌源文件指纹（`wiki-distill-{org}-{entryId}-{sha256前12}`）——
 * 重跑时文件未变 ⇒ id 已存在 ⇒ 整篇跳过（不重复入队）；文件变了 ⇒ 新指纹新候选，
 * 旧行（含已拒绝项）留档不动。
 *
 * 质量控制：蒸馏段先过机械稳定化（去代码块/去日期/转义锚点字面量/限行宽行量），
 * 再过票02 lint 闸（L1 容量 / L5 长代码块与日期）——被拦 ⇒ 记入 failed 返工，不入队。
 */

/** 蒸馏产物：结论段 + 依据段的要点行（每段 ≤MAX_BULLETS 条）。 */
export interface DistillSummary {
  conclusion: string[]
  rationale: string[]
}

export interface DistillDocInput {
  /** POSIX 相对 docs 根上级的仓库路径，如 docs/research/knowledge-system/README.md */
  relPath: string
  kind: "research" | "adr"
  title: string
  /** 原文正文（只读，供蒸馏；原文本体永不改写） */
  body: string
}

/** LLM 蒸馏 seam（RuleFormJudge 同型：异步、可注入、测试 fixture 固化）。 */
export type DistillSummarizer = (doc: DistillDocInput) => Promise<DistillSummary>

export interface DistillReport {
  /** 本次新入队的候选（每源文件一条，可追溯） */
  queued: Array<{ source: string; entryId: string; path: string; itemId: string }>
  /** 指纹行已存在 ⇒ 跳过（幂等证明主体） */
  skipped: string[]
  /** lint/蒸馏失败 ⇒ 返工名单（不入队、不写盘） */
  failed: Array<{ source: string; error: string }>
  totals: { sources: number; queued: number; skipped: number; failed: number }
}

export interface DistillOptions {
  db: Database.Database
  org: string
  /** wiki 根覆盖（候选本身不写 wiki，root 仅供 lint 断链判定与采纳端一致） */
  rootDir?: string
  /** docs 根覆盖（缺省 process.cwd()/docs；测试传 tmpdir fixture） */
  docsRoot?: string
  /** 蒸馏 seam（缺省 = 启发式兜底，离线可跑；生产 index.ts 注入 LLMCall 适配器） */
  summarizer?: DistillSummarizer
}

/** 蒸馏段机械约束：要点行数、行宽（守 L1 容量闸 margin）。 */
const MAX_BULLETS = 6
const MAX_LINE_CHARS = 200
/** 静态初始置信度：LLM 蒸馏未经人审 ⇒ 低于存量迁移的 0.8（spec：confidence 静态初值）。 */
const DISTILL_CONFIDENCE = 0.7

function sha256_12(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 12)
}

/** 文件名/相对路径 → 词条 id 词元（小写 kebab；首字母由域前缀 res-/biz-adr- 保证）。 */
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
  return slug || "doc"
}

/**
 * 蒸馏要点行稳定化：候选进队列前逐行净化——
 * 去 HTML 注释（防来源文档里的锚点字面量被当真锚点）、围栏代码块整块丢弃、
 * 日期出现剔除（常青正文零日期，L5）、[[wikilink]] 去形（候选未入库，链接必断，L5）。
 */
export function stabilizeSummaryLines(lines: string[]): string[] {
  const out: string[] = []
  let inFence = false
  // 内嵌换行展开：LLM 常把整个代码块塞进「一条要点」，按行处理才能成对闭合围栏
  for (const raw of lines.flatMap(l => l.split("\n"))) {
    const line = raw.trim()
    if (!line) continue
    if (/^\s{0,3}```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue // 代码块内容永不进结论段（票面：禁复制原文长段）
    let s = line.replace(/<!--[\s\S]*?-->/g, "").trim()
    if (!s) continue
    s = s.replace(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日/g, "").trim()
    s = s.replace(/\[\[/g, "[ [").replace(/\]\]/g, "] ]")
    // 净化后仍可能空行（纯日期行）
    if (!s) continue
    out.push(s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS) + "…" : s)
    if (out.length >= MAX_BULLETS) break
  }
  return out
}

// ── 蒸馏 seam 的缺省与生产适配器 ────────────────────────────────

const CONCLUSION_H2_RE = /结论|决策|建议|摘要|总览|overview|summary|decision/i
const RATIONALE_H2_RE = /依据|理由|原因|背景|分析|动机|约束|取舍|rationale|context|why/i
/** ADR/文档头元数据行（状态/日期）不当要点搬运。 */
const METADATA_LINE_RE = /^(状态|日期|决定日期|记录|status|date|deciders?|backdrop)\s*[:：]/i

/**
 * 启发式兜底蒸馏器（离线缺省，零模型调用）：整段丢弃围栏代码块后，
 * 按 H2 取「结论/决策」类小节作结论段、「依据/理由/背景」类小节作依据段；
 * 小节内优先要点行（剔除元数据行），退化到正文前两段。
 * 输出仍过 stabilizeSummaryLines 净化 + lint 闸——兜底不豁免质量律。
 */
export const heuristicDistillSummarizer: DistillSummarizer = async (doc) => {
  let inFence = false
  const lines: string[] = []
  for (const l of doc.body.split("\n")) {
    if (/^\s{0,3}```/.test(l)) { inFence = !inFence; continue }
    if (inFence) continue
    lines.push(l)
  }
  const { preamble, sections } = parseH2Sections(lines.join("\n"))
  const pick = (titleRe: RegExp): string[] => {
    const sec = sections.find(s => titleRe.test(s.title))
    const src = (sec?.lines ?? preamble).map(l => l.trim())
    const bullets = src
      .filter(l => /^[-*]\s+\S/.test(l))
      .map(l => l.replace(/^[-*]\s+/, ""))
      .filter(l => !METADATA_LINE_RE.test(l))
    if (bullets.length > 0) return bullets
    return src.filter(l => l && !/^[#|>`]/.test(l) && !/^[-*]/.test(l) && !METADATA_LINE_RE.test(l)).slice(0, 2)
  }
  return { conclusion: pick(CONCLUSION_H2_RE), rationale: pick(RATIONALE_H2_RE) }
}

const MAX_PROMPT_CHARS = 6000

/**
 * 生产适配器（handoff-02 L6 同法：seam 注入，单测一律 fixture-mocked llmCall，不打真模型）：
 * index.ts 用 knowledge/llm 的 callHaiku/createProviderLLMCall 包装注入。
 * 输出纪律写进 prompt（零日期/无代码摘录/祈使句——与稳定化+lint 闸同律）；
 * 模型不可达或产出不合律 ⇒ 逐篇启发式兜底（降级不中断，failed 只留给真错误）。
 */
export function createLLMDistillSummarizer(
  llmCall: (prompt: string) => Promise<string>,
  fallback: DistillSummarizer = heuristicDistillSummarizer,
): DistillSummarizer {
  return async (doc) => {
    const prompt = [
      "你是知识编译器。把下面文档蒸馏成 wiki 词条草案要点，只输出严格 JSON：" +
      '{"conclusion": ["…"], "rationale": ["…"]}。' +
      "规则：每段≤4条；每条≤80字；祈使或事实陈述；禁止日期；禁止复制代码块或长段原文；禁止 [[链接]]。",
      `【文档类型】${doc.kind === "adr" ? "架构决策记录（结论段=决策，依据段=理由）" : "调研报告（结论段=结论，依据段=决策依据）"}`,
      `【标题】${doc.title}`,
      `【正文】`,
      doc.body.slice(0, MAX_PROMPT_CHARS),
    ].join("\n\n")
    try {
      const raw = await llmCall(prompt)
      const m = /\{[\s\S]*\}/.exec(raw)
      if (!m) throw new Error("LLM 响应无 JSON 对象")
      const parsed = JSON.parse(m[0]) as { conclusion?: unknown; rationale?: unknown }
      const asLines = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []
      const conclusion = asLines(parsed.conclusion)
      if (conclusion.length === 0) throw new Error("LLM 结论段为空")
      return { conclusion, rationale: asLines(parsed.rationale) }
    } catch {
      return fallback(doc)
    }
  }
}

/** 递归列出 docs/research 与 docs/adr 下全部 .md（POSIX rel，稳定排序）。 */
export function listDistillSources(docsRoot: string): Array<{ rel: string; abs: string; kind: "research" | "adr" }> {
  const out: Array<{ rel: string; abs: string; kind: "research" | "adr" }> = []
  for (const kind of ["research", "adr"] as const) {
    const base = path.join(docsRoot, kind)
    const walk = (dir: string, relDir: string) => {
      let names: string[]
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
      } catch {
        return // 目录不存在（fixture 常只有半边）
      }
      for (const e of names) {
        const abs = path.join(dir, e.name)
        const rel = `docs/${relDir}/${e.name}`.replace(/\\/g, "/")
        if (e.isDirectory()) walk(abs, `${relDir}/${e.name}`)
        else if (e.name.endsWith(".md")) out.push({ rel, abs, kind })
      }
    }
    walk(base, kind)
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export class WikiDistillService {
  private readonly org: string
  private readonly root: string
  private readonly docsRoot: string
  private readonly summarizer: DistillSummarizer
  private readonly pending: PendingReviewDAO

  constructor(opts: DistillOptions) {
    this.org = opts.org
    this.root = resolveWikiRoot(opts.org, opts.rootDir)
    this.docsRoot = opts.docsRoot ?? path.join(process.cwd(), "docs")
    this.summarizer = opts.summarizer ?? heuristicDistillSummarizer
    this.pending = new PendingReviewDAO(opts.db)
  }

  get wikiRoot(): string {
    return this.root
  }

  async run(): Promise<DistillReport> {
    const report: DistillReport = { queued: [], skipped: [], failed: [], totals: { sources: 0, queued: 0, skipped: 0, failed: 0 } }
    ensureWikiSkeleton(this.root)

    for (const src of listDistillSources(this.docsRoot)) {
      report.totals.sources++
      const raw = fs.readFileSync(src.abs, "utf-8")
      const hash = sha256_12(raw)
      const { domain, entryId, relPath } = this.candidateTarget(src.rel, src.kind)
      const itemId = `wiki-distill-${this.org}-${entryId}-${hash}`

      // 幂等闸：同指纹行已存在（pending/approved/rejected 皆算）⇒ 不重复入队
      if (this.pending.getById(itemId)) {
        report.skipped.push(src.rel)
        continue
      }

      try {
        const draft = await this.buildDraft(src.rel, src.kind, raw, hash, domain, entryId, relPath)
        this.pending.insert(draft)
        report.queued.push({ source: src.rel, entryId, path: relPath, itemId })
      } catch (err) {
        // lint 拦下 / 蒸馏失败 ⇒ 返工名单，不入队、不写盘
        report.failed.push({ source: src.rel, error: err instanceof Error ? err.message : String(err) })
      }
    }

    report.totals.queued = report.queued.length
    report.totals.skipped = report.skipped.length
    report.totals.failed = report.failed.length
    return report
  }

  private candidateTarget(rel: string, kind: "research" | "adr"): {
    domain: "research" | "business"
    entryId: string
    relPath: string
  } {
    // docs/research/a/b.md → res-a-b ；docs/adr/0099-x.md → biz-adr-0099-x
    const body = rel.replace(/^docs\/(research|adr)\//, "").replace(/\.md$/i, "")
    const slug = slugify(body.split("/").join("-"))
    const domain = kind === "research" ? "research" as const : "business" as const
    const entryId = kind === "research" ? `res-${slug}` : `biz-adr-${slug}`
    return { domain, entryId, relPath: `${domain}/${entryId}.md` }
  }

  /** 三段式候选词条草案 + lint 质量闸 + 队列行载荷（零写盘——只 INSERT pending_review）。 */
  private async buildDraft(
    rel: string,
    kind: "research" | "adr",
    raw: string,
    hash: string,
    domain: "research" | "business",
    entryId: string,
    relPath: string,
  ): Promise<Parameters<PendingReviewDAO["insert"]>[0]> {
    const title = /^#\s+(.*\S)\s*$/m.exec(raw)?.[1]?.trim() ?? path.basename(rel, ".md")
    const summary = await this.summarizer({ relPath: rel, kind, title, body: raw })
    const conclusion = stabilizeSummaryLines(summary.conclusion)
    const rationale = stabilizeSummaryLines(summary.rationale)
    if (conclusion.length === 0) throw new Error("DISTILL_EMPTY_CONCLUSION: 蒸馏结果为空（返工：该源不产候选）")

    const conclusionH2 = kind === "research" ? "结论" : "决策"
    const rationaleH2 = kind === "research" ? "决策依据" : "理由"
    const body = [
      `## ${conclusionH2}`,
      "",
      ...conclusion.map(l => `- ${l}`),
      "",
      `## ${rationaleH2}`,
      "",
      ...rationale.map(l => `- ${l}`),
      "",
      "## 来源指针",
      "",
      `- doc:${rel}`,
      "",
    ].join("\n")

    const meta: WikiEntryFrontmatter = {
      id: entryId,
      domain,
      title: `蒸馏候选 · ${title}`.slice(0, 80),
      summary: (conclusion[0] ?? title).slice(0, 60),
      topics: ["distill-migration", kind],
      stability: "stable",
      last_compiled: today(),
      sources: [`doc:${rel}`],
      confidence: DISTILL_CONFIDENCE,
    }

    // 票02 lint 闸前移做质量控制（编译端同闸再跑一次，双保险）：error ⇒ 抛给返工名单
    const content = serializeEntryMarkdown(meta, body)
    const lint = lintWikiEntry({
      meta,
      body,
      anchors: extractRuleAnchors(body),
      root: this.root,
      linkCorpus: [{ id: meta.id, path: relPath }],
    })
    if (lint.errors.length > 0) {
      throw new Error(`DISTILL_LINT_REJECTED: ${lint.errors.map(e => `${e.code} — ${e.message}`).join("；")}`)
    }

    return {
      id: `wiki-distill-${this.org}-${entryId}-${hash}`,
      type: "wiki-edit",
      source: "distill-migration",
      source_ref: `${rel}#${hash}`,
      source_label: `蒸馏候选 · ${rel}`,
      content: JSON.stringify({ kind: "wiki-edit", path: relPath, createEntry: content }),
      target_file: relPath,
      scope: "wiki",
      conflicts: null,
      confidence: DISTILL_CONFIDENCE,
      auto_approve: 0,
      status: "pending",
      user_notes: null,
    }
  }
}
