// packages/server/src/services/knowledge/case-extract-service.ts
//
// 判例自动提取 + 自动入档 — P3 票03 主服务（spec §Implementation Decisions「判例自动提取」，
// 故事 8-10/12/14）。
//
// 链（归档 hook 内第⑤步，票02 素材包链之后）：
//  ① 读提取源 = 本次归档任务的素材包（持久面——workspace 会删，包是源）：
//     `exec-jsonl-excerpt`（报错→诊断→修复序列）+ `phase-rejections`（打回轮次，理由入现场段）。
//     逐件 hash 对质（不可变契约）；两件都「诚实缺席」⇒ NO_SEQUENCE，零 LLM 零入队。
//  ② LLM seam（createProductionKnowledgeLLM 通道，ArchiveIngestService summarize 同款先例）
//     产五段草案（现场/诊断/根因/修复/教训 + symptom/severity/tags/source）——
//     source 指回 exec/task：草案给的可定位指针照用，缺/不可定位 ⇒ 服务端兜 `task:{id}`
//     （准入闸 compileCase 会再强制 LOCATABLE_SOURCE_RE，双保险零假源落盘）。
//  ③ 入档 = **case-archive 第八类 opKind 入全局串行队列**（红线2：判例一切写经此通道，
//     禁直写 cases/）。队列执行体（持写锁位）内做同症状判定：
//     命中既判例（归一化+jaccard，case-symptom.ts 自建纯函数）⇒ occurrences+1
//     （compileCase 可变面：仅 status/rule_ref/occurrences/procedural；正文 append-only 不改写）；
//     未命中 ⇒ 新判例（P0 front-matter schema 沿用，宽松准入直接入档，豁免半衰期）。
//  ④ 判例卡通知（红线3：先存后知——**编译 committed 之后**才 emit，失败不知会；
//     Lane A 生产者 dep 注入，announce 炸只吞 stderr 不毁入档）。
//
// 失败语义（票面第 6 行负断言）：提取失败/无序列可提/LLM 缺席或坏形/草案全不合规 ⇒
// 零落盘零入队（不产假判例）；本服务**永不向调用方抛错**（skipped+reason 收敛），
// 失败不阻塞归档 done（K11 零触碰，与票02 投喂链同律）。
//
// 红线5 零触碰：只经唯一写闸写 cases/；agent 记忆域/user_preference 不在射程。

import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import type { KcCardEvent, KcCaseCardData, KcCaseCardSections } from "@octopus/shared"
import { LOCATABLE_SOURCE_RE, WIKI_CASE_SECTIONS, type WikiCaseFrontmatter } from "@octopus/shared"
import { GLOBAL_WIKI_ORG, resolveKnowledgeRoot } from "./global-paths"
import { readPackManifest, packActiveItems, type MaterialPackItem } from "./material-pack"
import { stripRawFrontMatter, sha256Text, sha10 } from "./raw"
import type { WriteQueue } from "./wiki/compile-queue"
import { WikiCompileService, scanWikiEntries } from "./wiki/compile"
import { parseCaseMarkdown, serializeCaseMarkdown } from "./wiki/format"
import type { GitRunner } from "./wiki/wiki-git"
import { findSimilarSymptom } from "./case-symptom"
import type { LLMCall } from "./llm"

// ── 命名契约（单源，测试/队列面/路由消费）─────────────────────────────

/** 判例入档队列任务 id 前缀——GET /api/knowledge/wiki/queue/task/:id 可查面。 */
export const CASE_EXTRACT_QUEUE_ID_PREFIX = "caw-"
/** 判例退役队列任务 id 前缀（retireCase 通道，同 opKind=case-archive）。 */
export const CASE_RETIRE_QUEUE_ID_PREFIX = "car-"

/** 单次归档最多入档判例数（噪声防洪闸——spec 判例质量风险预案的运营参数）。 */
export const CASE_DRAFT_MAX = 5

/** 单件素材进 prompt 的字节上限（焦点件口径，material-pack 同族预算）。 */
const EXTRACT_ITEM_CAP_BYTES = 20_000

// ── 草案契约（LLM JSON 面；expected 真相源=spec 五段骨架）─────────────

export interface CaseDraft {
  symptom: string
  severity: string
  tags: string[]
  /** 可定位溯源指针（不可定位会被服务端兜成 task:{id}） */
  source: string
  sections: KcCaseCardSections
}

export interface CaseExtractFacts {
  taskId: string
  execExcerpt: string
  rejections: string
}

/** 五段草案 prompt（纯函数单源——service 与测试断言同一入口）。 */
export function buildCaseExtractPrompt(f: CaseExtractFacts): string {
  const clip = (s: string): string =>
    Buffer.byteLength(s, "utf-8") <= EXTRACT_ITEM_CAP_BYTES ? s : `${s.slice(0, EXTRACT_ITEM_CAP_BYTES)}\n…（截断，全文见素材包件）`
  return `# 判例自动提取（Case Extract · task ${f.taskId}）

你是任务归档判例提取器。从下面这个已归档任务的两类一手素材里，提取**值得留档的踩坑判例**
（CBR 案例库语义：判例比法条更贴现场；后续 agent 卡壳按症状检索命中）。

## 输出契约

只输出一个 JSON 对象（可 \`\`\`json 围栏），形状：

{"cases":[{"symptom":"<一句话症状，检索主键，写用户视角现象>",
"severity":"blocker|major|minor",
"tags":["<小写英文或短标签，≤8>"],
"source":"<指回素材里的 exec:/task: 指针，如 exec:xxx>",
"sections":{"现场":"…","诊断":"…","根因":"…","修复":"…","教训":"…"}}]}

硬性纪律：
1. **五段齐全且非空**（现场/诊断/根因/修复/教训），缺段的判例会被服务端整条丢弃。
2. **只写素材里真实发生过的事**，不得虚构报错文本/修复动作；打回理由属「现场」段。
3. source 必须取自素材内可见的 exec/task 指针；拿不准就写 task:${f.taskId}。
4. 无坑可提（素材干净跑完）就输出 {"cases":[]}——宁缺毋假。
5. 最多 ${CASE_DRAFT_MAX} 条；症状彼此不同（同症状会被并档，不必重复提）。

## 素材一 · 执行 JSONL 关键事件摘录（报错→诊断→修复序列）

${clip(f.execExcerpt)}

## 素材二 · phase 打回记录（流程性教训；理由入现场段）

${clip(f.rejections)}
`
}

// ── 提取源判定（票面第 6 行负断言的结构判据，零 LLM 先行）──────────────

/** JSONL 摘录件是否含可提取序列：渲染行恒带 ` :: `；「无关键事件/无执行记录/缺席」皆无此形。 */
export function jsonlHasSequences(payload: string): boolean {
  return payload.includes(" :: ") || payload.includes("重试痕迹节点")
}

/** 打回件是否含 rejected 轮次：逐条打回渲染 `## phase N round M 打回`；空账恒「（无打回轮次…」。 */
export function rejectionsHasRounds(payload: string): boolean {
  return /^## phase \d+ round \d+ 打回/m.test(payload)
}

// ── Outcome ──────────────────────────────────────────────────────────

export type CaseExtractStatus = "enqueued" | "skipped"

/** 退役通道同步校验错误（PackOpsError/ReviewError 同族制式：code 稳定词 + HTTP status）。 */
export class CaseArchiveError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "CaseArchiveError"
  }
}

export interface CaseExtractOutcome {
  status: CaseExtractStatus
  /** skipped 原因码（稳定词，进 stderr/测试断言） */
  reason?: string
  /** 入队的草案数（enqueued 时有值） */
  drafts?: number
  queueTaskIds?: string[]
}

// ── Deps ─────────────────────────────────────────────────────────────

export interface CaseExtractDeps {
  db: Database.Database
  /** 知识根（测试注入 tmpdir；缺省 resolveKnowledgeRoot()，patrol/findings 同律） */
  root?: string
  /** 全局写串行队列（case-archive 第八类唯一通道，红线2） */
  queue: WriteQueue
  /** 五段草案 LLM seam（生产 = createProductionCaseExtractor；测试恒 fixture mock） */
  extract: LLMCall
  /** 判例卡 Lane A 生产者（index.ts 接 appendKnowledgeSessionCards；缺省不产卡，抛错吞 stderr） */
  announceCase?: (event: KcCardEvent) => void
  git?: GitRunner
  now?: () => Date
}

// ── 草案校验（宽松准入的「真实+可定位」服务端形态：结构不合格整条弃，不产假判例）──

export function toCaseDraft(raw: unknown, taskId: string): CaseDraft | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const symptom = typeof rec.symptom === "string" ? rec.symptom.trim() : ""
  if (symptom === "") return undefined
  const sectionsRaw = rec.sections
  if (!sectionsRaw || typeof sectionsRaw !== "object" || Array.isArray(sectionsRaw)) return undefined
  const srec = sectionsRaw as Record<string, unknown>
  const sections = {} as KcCaseCardSections
  for (const key of WIKI_CASE_SECTIONS) {
    const v = srec[key]
    if (typeof v !== "string" || v.trim() === "") return undefined // 缺一段即弃（不产半成品判例）
    sections[key] = v.trim()
  }
  const severity = typeof rec.severity === "string" && rec.severity.trim() !== "" ? rec.severity.trim() : "minor"
  const tags = Array.isArray(rec.tags)
    ? [...new Set(rec.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map(t => t.trim()))].slice(0, 8)
    : []
  const rawSource = typeof rec.source === "string" ? rec.source.trim() : ""
  const source = LOCATABLE_SOURCE_RE.test(rawSource) ? rawSource : `task:${taskId}`
  return { symptom: symptom.slice(0, 120), severity, tags, source, sections }
}

/** LLM 响应 → 草案数组（json 围栏剥取 + 结构闸；坏形/空 = []）。 */
export function parseCaseDrafts(resp: string, taskId: string): CaseDraft[] {
  let text = resp.trim()
  if (text === "") return []
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return []
  let plan: unknown
  try {
    plan = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const cases = (plan as { cases?: unknown }).cases
  if (!Array.isArray(cases)) return []
  const out: CaseDraft[] = []
  for (const c of cases) {
    const d = toCaseDraft(c, taskId)
    if (d) out.push(d)
    if (out.length >= CASE_DRAFT_MAX) break
  }
  return out
}

/** 判例正文（五段按 CBR 叙事序）——与 parseCaseSections 往返一致。 */
export function caseBodyFromSections(sections: KcCaseCardSections): string {
  return WIKI_CASE_SECTIONS.map(s => `## ${s}\n\n${sections[s]}\n`).join("\n")
}

/**
 * 判例正文 → 五段 map（卡面预览用；缺段落空串——卡仍可读）。
 * P3 票04 修（潜伏缺陷移交）：旧单正则懒匹配 `(?=…|$)` 在 m 标志下于「标题后的
 * 空行行首」立即为真（`$` 匹配零宽行尾）⇒ 标准 `## X\n\n正文` 制式下五段全空。
 * 改行切分制：段=两标题行之间内容 trim；首标题前的散文忽略；未知小节名忽略。
 * 影响面：merged/retired 卡的 sections 预览（原恒空串，修复后真实——票04 b 路
 * 「流程型」判据同样依赖此面）。
 */
export function parseCaseSections(body: string): KcCaseCardSections {
  const out = { 现场: "", 诊断: "", 根因: "", 修复: "", 教训: "" } as KcCaseCardSections
  const bucket: Partial<Record<string, string[]>> = {}
  let current: string | null = null
  for (const line of body.split(/\r?\n/)) {
    const m = /^## (现场|诊断|根因|修复|教训)(?:\s+\S.*|\s*)$/.exec(line)
    if (m) {
      current = m[1] ?? null
      if (current !== null && !(current in bucket)) bucket[current] = []
      continue
    }
    if (current !== null) bucket[current]?.push(line)
  }
  for (const [k, lines] of Object.entries(bucket)) {
    out[k as keyof KcCaseCardSections] = lines.join("\n").trim()
  }
  return out
}

// ── Service ──────────────────────────────────────────────────────────

export class CaseExtractService {
  readonly root: string
  readonly wikiRoot: string
  private readonly db: Database.Database
  private readonly queue: WriteQueue
  private readonly extract: LLMCall
  private readonly announceCase?: (event: KcCardEvent) => void
  private readonly git?: GitRunner
  private readonly now: () => Date
  private seq = 0

  constructor(deps: CaseExtractDeps) {
    this.db = deps.db
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.queue = deps.queue
    this.extract = deps.extract
    this.announceCase = deps.announceCase
    this.git = deps.git
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * 提取+入档入口（归档 hook 第⑤步消费）。**永不抛错**——失败收敛为 skipped，
   * 零落盘零入队（不产假判例），不阻塞 done。
   */
  async extractAndEnqueue(taskId: string): Promise<CaseExtractOutcome> {
    // ① 读包（持久面）；结构闸先行，无序列可提 = 零 LLM 调用零入队
    let items: MaterialPackItem[]
    try {
      const manifest = readPackManifest(this.root, taskId)
      if (!manifest) return this.skip("PACK_NOT_FOUND", `素材包不存在：task-${taskId}`)
      items = packActiveItems(manifest)
    } catch (err) {
      return this.skip("PACK_READ_FAILED", err instanceof Error ? err.message : String(err))
    }
    const excerptItem = items.find(i => i.kind === "exec-jsonl-excerpt") ?? null
    const rejectionsItem = items.find(i => i.kind === "phase-rejections") ?? null
    if (!excerptItem && !rejectionsItem) return this.skip("NO_SEQUENCE", "包内无 exec-jsonl-excerpt / phase-rejections 件")

    let execExcerpt = ""
    let rejections = ""
    try {
      if (excerptItem) execExcerpt = this.readVerifiedItem(excerptItem)
      if (rejectionsItem) rejections = this.readVerifiedItem(rejectionsItem)
    } catch (err) {
      return this.skip("PACK_HASH_MISMATCH", err instanceof Error ? err.message : String(err))
    }
    const hasJsonl = excerptItem !== null && jsonlHasSequences(execExcerpt)
    const hasRej = rejectionsItem !== null && rejectionsHasRounds(rejections)
    if (!hasJsonl && !hasRej) return this.skip("NO_SEQUENCE", "两源均无报错序列/打回轮次（干净跑完）——零入队")

    // ② LLM 草案（seam；缺席/失败/坏形 = 不产，绝不落半成品）
    const prompt = buildCaseExtractPrompt({ taskId, execExcerpt, rejections })
    let resp = ""
    try {
      resp = await this.extract(prompt)
    } catch (err) {
      return this.skip("EXTRACT_FAILED", err instanceof Error ? err.message : String(err))
    }
    if (resp.trim() === "") return this.skip("EXTRACT_EMPTY", "提取 LLM 无响应（缺席或被禁用）")
    const drafts = parseCaseDrafts(resp, taskId)
    if (drafts.length === 0) return this.skip("NO_VALID_DRAFT", "草案结构不合格（五段/symptom 缺失），不产假判例")

    // ③ 逐草案入队 case-archive（第八类唯一通道）；同症状判定/编译在队列执行体内（持写锁位，竞态安全）
    const queueTaskIds: string[] = []
    for (const draft of drafts) {
      const qid = `${CASE_EXTRACT_QUEUE_ID_PREFIX}${taskId}-${String(++this.seq).padStart(2, "0")}`
      try {
        this.queue.enqueue("case-archive", () => this.archiveDraft(qid, taskId, draft), {
          taskId: qid,
          label: `case:${draft.symptom}`,
        })
        queueTaskIds.push(qid)
      } catch (err) {
        process.stderr.write(`[case-extract] enqueue failed for ${qid}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
    if (queueTaskIds.length === 0) return this.skip("ENQUEUE_FAILED", "全部草案入队失败")
    return { status: "enqueued", drafts: queueTaskIds.length, queueTaskIds }
  }

  /**
   * 判例退役（故事 11 的确定性执行面：策展对话/卡片钮的落点）——
   * 同 opKind=case-archive 入唯一写闸，compileCase 可变面 status→superseded，正文 append-only 不动。
   * 返回队列任务 id（状态可查 GET /wiki/queue/task/:id）。错误响亮抛给路由（同步校验段零副作用）。
   */
  retireCase(caseId: string): { queueTaskId: string; casePath: string } {
    const entry = this.findCaseById(caseId)
    if (!entry) throw new CaseArchiveError("CASE_NOT_FOUND", `判例不在盘：${caseId}`, 404)
    if (entry.case!.status === "superseded") throw new CaseArchiveError("CASE_ALREADY_SUPERSEDED", `'${caseId}' 已退役`, 409)
    const qid = `${CASE_RETIRE_QUEUE_ID_PREFIX}${caseId}-${String(++this.seq).padStart(2, "0")}`
    this.queue.enqueue("case-archive", () => this.applyCaseUpdate(qid, entry.relPath, { status: "superseded" }, `判例退役 superseded（票03 事后纠通道）`), {
      taskId: qid,
      label: `case-retire:${caseId}`,
    })
    return { queueTaskId: qid, casePath: entry.relPath }
  }

  // ── 队列执行体 ──────────────────────────────────────────────────────

  /** 入档执行体（持串行位）：同症状命中→occurrences+1；未命中→新判例。成功 committed 后才 emit 判例卡（先存后知）。 */
  private async archiveDraft(queueTaskId: string, taskId: string, draft: CaseDraft): Promise<void> {
    const compiler = this.compiler()
    const cases = scanWikiEntries(this.wikiRoot)
      .filter(e => e.case !== undefined && e.relPath.startsWith("cases/"))
      .sort((a, b) => a.relPath.localeCompare(b.relPath)) // 确定性决胜序（同分取先位）

    const hit = findSimilarSymptom(cases.map(e => e.case!.symptom), draft.symptom)
    if (hit !== undefined) {
      const target = cases[hit.index]!
      await this.applyCaseUpdate(
        queueTaskId,
        target.relPath,
        { occurrences: target.case!.occurrences + 1 },
        `判例并档 occurrence ${target.case!.occurrences + 1}（源 task-${taskId}）`,
      )
      return
    }

    const date = this.now().toISOString().slice(0, 10)
    const id = `case-${sha10(draft.symptom)}`
    const meta: WikiCaseFrontmatter = {
      id,
      domain: "cases",
      symptom: draft.symptom,
      tags: draft.tags,
      severity: draft.severity,
      occurrences: 1,
      source: draft.source,
      status: "open",
    }
    const body = caseBodyFromSections(draft.sections)
    const res = await compiler.compileEntry({
      content: serializeCaseMarkdown(meta, body),
      fileName: `${date}-${id}.md`,
      source: `task:${taskId}`,
      reviewer: "auto-extract",
      note: `判例自动提取（task-${taskId}）`,
    })
    this.announce(queueTaskId, meta, draft.sections, res.path, taskId, "created")
  }

  /** 可变面更新（occurrences/退役共用）：读盘现文→只动 status/occurrences/rule_ref→重编译（正文 append-only 原样）。 */
  private async applyCaseUpdate(queueTaskId: string, relPath: string, patch: { status?: "superseded" | "open" | "distilled"; occurrences?: number; rule_ref?: string }, note: string): Promise<void> {
    const compiler = this.compiler()
    const abs = path.join(this.wikiRoot, relPath)
    const { meta, body } = parseCaseMarkdown(fs.readFileSync(abs, "utf-8"))
    const next: WikiCaseFrontmatter = {
      ...meta,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.occurrences !== undefined ? { occurrences: patch.occurrences } : {}),
      ...(patch.rule_ref !== undefined ? { rule_ref: patch.rule_ref } : {}),
    }
    const fileName = relPath.split("/").pop() ?? `${meta.id}.md`
    const res = await compiler.compileEntry({
      content: serializeCaseMarkdown(next, body),
      fileName,
      source: `case-archive:${queueTaskId}`,
      reviewer: "auto-extract",
      note,
    })
    this.announce(queueTaskId, next, parseCaseSections(body), res.path, undefined, patch.status === "superseded" ? "retired" : "merged")
  }

  // ── 内部件 ─────────────────────────────────────────────────────────

  private compiler(): WikiCompileService {
    return new WikiCompileService({
      db: this.db,
      org: GLOBAL_WIKI_ORG,
      rootDir: this.wikiRoot,
      ...(this.git ? { git: this.git } : {}),
    })
  }

  private findCaseById(caseId: string) {
    return scanWikiEntries(this.wikiRoot).find(e => e.case !== undefined && e.relPath.startsWith("cases/") && e.meta.id === caseId)
  }

  /** 件正文回读 + 不可变契约对质（manifest 声称 hash vs 盘上实算）。 */
  private readVerifiedItem(item: MaterialPackItem): string {
    const abs = path.join(this.root, ...item.path.split("/"))
    const content = stripRawFrontMatter(fs.readFileSync(abs, "utf-8"))
    if (sha256Text(content) !== item.sha256) {
      throw new Error(`件 hash 对质失败（不可变契约）：${item.path}`)
    }
    return content
  }

  /** 判例卡 emit（先存后知：仅在编译 committed 后到达）。抛错吞 stderr——通知失败不毁入档。 */
  private announce(queueTaskId: string, meta: WikiCaseFrontmatter, sections: KcCaseCardSections, relPath: string, taskId: string | undefined, action: KcCaseCardData["action"]): void {
    if (!this.announceCase) return
    try {
      const data: KcCaseCardData = {
        caseId: meta.id,
        path: relPath,
        symptom: meta.symptom,
        severity: meta.severity,
        tags: meta.tags,
        occurrences: meta.occurrences,
        ...(meta.rule_ref !== undefined ? { ruleRef: meta.rule_ref } : {}),
        status: meta.status,
        source: meta.source,
        sections,
        ...(taskId !== undefined ? { taskId } : {}),
        queueTaskId,
        action,
      }
      this.announceCase({ id: `cse-${meta.id}`, kind: "case", ts: this.now().toISOString(), data })
    } catch (err) {
      process.stderr.write(`[case-extract] announce failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  private skip(reason: string, detail: string): CaseExtractOutcome {
    process.stderr.write(`[case-extract] skipped: ${reason} — ${detail}\n`)
    return { status: "skipped", reason }
  }
}
