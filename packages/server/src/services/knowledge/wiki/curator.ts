import type Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import type { WikiPageFrontmatter } from "@octopus/shared"
import type { LLMCall } from "../llm"
import type { RawPointer } from "../raw"
import { ensureKnowledgeSkeleton, getGlobalWikiRoot, GLOBAL_WIKI_ORG, resolveKnowledgeRoot } from "../global-paths"
import { WikiCompileService, scanWikiEntries, nextRuleAnchor, type BatchPageInput } from "./compile"
import { WikiLintError, WIKILINK_RE, lintProfileForPageType } from "./lint"
import { serializePageMarkdown, extractRuleAnchors, pageDirForType, parseWikiFile, findDateOccurrences } from "./format"
import { ensureSchemaDoc, SCHEMA_DOC_FILE } from "./schema-doc"
import { FindingsDAO } from "../../../db/dao/findings-dao"
import type { GitRunner } from "./wiki-git"

/**
 * CuratorCompileService — 策展编译管线（知识中心票05 主链条，三层架构 raw→wiki）。
 *
 * 流程（prototype Tab③「Ingest 入口 A」逐格 / spec §审批废除与写入闸门）：
 *   读 SCHEMA.md + INDEX.md（编译前必读）→ 全文读 raw → LLM 抽取实体/概念/断言
 *   → 对照现 wiki diff（id 在盘=update，缺席=create）→ **一次编译写 N 页**
 *   （entities/concepts/topics + 程序化 sources 回执页）→ INDEX/LOG/FTS/git 单一 commit
 *   （复用票04 写闸 compilePages 批通道——失败快照补偿回滚零半成品）。
 *
 * 纪律：
 * - **锚点由服务发号**（nextRuleAnchor 全库 max+1、永不复用）；LLM 只许用
 *   `<!--#oct-NEW-->` 占位，禁手写 oct-NNN——编号权不在模型侧。
 * - **矛盾不静默覆盖**：plan.contradictions ⇒ 两页矛盾标记 + findings 行（本票只产不裁）。
 * - **幂等**：sources 回执页存在且 raw hash 相符 ⇒ 快路径 no-op（不调 LLM、零副作用）；
 *   未命中快路径时全批产物与在盘逐字节相同同样 changed=false（compilePages 幂等判定）。
 * - **回指必须可解析**：sources 页正文的 `raw: <路径>` + `sha256: <hash>` 行是机械断言，
 *   对质时可正则取出并与 raw 文件实算 hash 互验。
 * - 单次编译入口（compileRaw）是同步 await 的原子单位——票06 的全局队列/锁直接整包它。
 */

export type { LLMCall } from "../llm"

/** 策展稳定错误：message 首词带码（wiki-compile.test 哨兵码断言先例），status 供路由层。 */
export class CuratorError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "CuratorError"
  }
}

export interface CuratorPlanPage {
  op?: "create" | "update"
  type: "entity" | "concept" | "topic"
  id: string
  entity_kind?: string
  aliases?: string[]
  topics?: string[]
  links?: string[]
  title: string
  summary: string
  stability?: "stable" | "volatile"
  review_after?: string
  confidence?: number
  /** markdown 正文（无 front-matter）；新硬约束行以 <!--#oct-NEW--> 占位 */
  body: string
}

export interface CuratorPlanContradiction {
  /** 与现库某页冲突：新断言所在页 id（须在 plan.pages 内）+ 旧页 path 或 id + 双方断言原文 */
  new_page: string
  old_page: string
  old_claim: string
  new_claim: string
}

export interface CuratorPlan {
  pages: CuratorPlanPage[]
  key_points?: string[]
  contradictions?: CuratorPlanContradiction[]
}

export interface CuratorTouchedPage {
  path: string
  type: string
  created: boolean
}

export interface CuratorCompileResult {
  rawPath: string
  rawHash: string
  rawTitle: string
  /** 触及页清单（含 sources 回执页）——DIFF 卡数据面 */
  touched: CuratorTouchedPage[]
  created: number
  updated: number
  contradictions: number
  findingIds: string[]
  commit: string | null
  changed: boolean
  /** true = 同 raw（同 hash）已编译过，快路径 no-op（未调 LLM、零副作用） */
  deduped: boolean
  warnings: string[]
}

export interface CuratorDeps {
  db: Database.Database
  /** 知识根覆盖（测试注入 tmpdir；缺省 resolveKnowledgeRoot：env > ~/.octopus/knowledge） */
  root?: string
  /** LLM 抽取 seam（rule-form-judge 注入先例；生产 = provider 适配器，测试 = mock 捕获 prompt） */
  llm: LLMCall
  git?: GitRunner
  now?: () => Date
}

const ANCHOR_TOKEN = "<!--#oct-NEW-->"
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex")
}

/** raw 文件头取标量（同 raw.ts 口径：去引号；缺 → null）。 */
function headerValue(frontMatter: string, key: string): string | null {
  const line = frontMatter.split("\n").find(l => l.startsWith(`${key}:`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1")
}

/**
 * 解析策展计划 JSON：容忍 ```json 围栏；结构校验失败 ⇒ CURATOR_LLM_JSON（可读错，
 * 拒在任何写副作用之前——失败零半成品由校验前置保证）。
 */
export function parseCuratorPlan(text: string): CuratorPlan {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new CuratorError("CURATOR_LLM_JSON", "模型响应里没有 JSON 对象", 502)
  }
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new CuratorError("CURATOR_LLM_JSON", `计划 JSON 解析失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, 502)
  }
  const rec = data as Record<string, unknown>
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.pages)) {
    throw new CuratorError("CURATOR_LLM_JSON", "计划缺少 pages 数组", 502)
  }
  const pages: CuratorPlanPage[] = rec.pages.map((rawPage, i) => {
    const p = rawPage as Record<string, unknown>
    const bad = (msg: string): never => {
      throw new CuratorError("CURATOR_LLM_JSON", `pages[${i}] ${msg}`, 502)
    }
    if (typeof p.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(p.id)) bad("id 必须是小写 kebab-case")
    if (p.type !== "entity" && p.type !== "concept" && p.type !== "topic") bad(`type 只许 entity/concept/topic（source 回执页由服务生成），得到 '${String(p.type)}'`)
    if (typeof p.title !== "string" || !p.title.trim()) bad("title 必填")
    if (typeof p.summary !== "string" || !p.summary.trim()) bad("summary 必填")
    if (typeof p.body !== "string" || !p.body.trim()) bad("body 必填")
    if (p.stability === "volatile" && typeof p.review_after !== "string") bad("volatile 页必须带 review_after（YYYY-MM-DD）")
    return {
      op: p.op === "update" ? "update" : "create",
      type: p.type,
      id: p.id,
      entity_kind: typeof p.entity_kind === "string" ? p.entity_kind : undefined,
      aliases: Array.isArray(p.aliases) ? p.aliases.filter((x): x is string => typeof x === "string") : [],
      topics: Array.isArray(p.topics) ? p.topics.filter((x): x is string => typeof x === "string") : [],
      links: Array.isArray(p.links) ? p.links.filter((x): x is string => typeof x === "string") : [],
      title: p.title,
      summary: p.summary,
      stability: p.stability === "stable" || p.stability === "volatile" ? p.stability : undefined,
      review_after: typeof p.review_after === "string" ? p.review_after : undefined,
      confidence: typeof p.confidence === "number" ? p.confidence : undefined,
      body: p.body,
    }
  })
  const keyPoints = Array.isArray(rec.key_points) ? rec.key_points.filter((x): x is string => typeof x === "string") : []
  const contradictions: CuratorPlanContradiction[] = Array.isArray(rec.contradictions)
    ? rec.contradictions.map((rawC, i) => {
        const c = rawC as Record<string, unknown>
        if (typeof c.new_page !== "string" || typeof c.old_page !== "string" || typeof c.old_claim !== "string" || typeof c.new_claim !== "string") {
          throw new CuratorError("CURATOR_LLM_JSON", `contradictions[${i}] 需要 new_page/old_page/old_claim/new_claim 四个字符串字段`, 502)
        }
        return { new_page: c.new_page, old_page: c.old_page, old_claim: c.old_claim, new_claim: c.new_claim }
      })
    : []
  if (pages.length === 0 && contradictions.length === 0 && keyPoints.length === 0) {
    throw new CuratorError("CURATOR_LLM_JSON", "计划三处皆空（pages/key_points/contradictions 全缺席）——拒收空编译", 502)
  }
  return { pages, key_points: keyPoints, contradictions }
}

/** 编译前必读三段（SCHEMA → INDEX → 现库页全文）+ raw 全文 + 输出契约。独立可测（prompt 是断言面对象）。 */
export function buildCuratorPrompt(opts: {
  schemaText: string
  indexText: string | null
  currentPages: Array<{ relPath: string; content: string }>
  raw: RawPointer
  rawTitle: string
  rawContent: string
}): string {
  const contract = {
    pages: [{
      op: "create|update",
      type: "entity|concept|topic",
      id: "前缀约定 ent- / con- / top- + kebab-case",
      entity_kind: "仅 entity：project|service|tool|org|person…",
      aliases: ["仅 entity 可选"],
      topics: ["可选标签"],
      links: ["裸页 id 数组（front-matter links）"],
      title: "页面标题",
      summary: "一行摘要（INDEX 消费）",
      stability: "stable|volatile（volatile 必带 review_after）",
      confidence: "0-1 可选",
      body: "markdown 正文（无 front-matter）。常青零日期；[[链接]] 目标必须存在于现库或本批",
    }],
    key_points: ["sources 回执页要点清单（本篇素材的独立可读要点）"],
    contradictions: [{
      new_page: "携带冲突断言的页 id（须出现在 pages 里）",
      old_page: "现库被冲突页的路径或 id",
      old_claim: "旧断言原文（逐字摘句）",
      new_claim: "新源断言（逐字摘句）",
    }],
  }
  return `# 策展编译任务（Curator Compile）

你是知识策展人（archive 分身）。对下面这篇不可变 raw 源做一次**多页编译规划**：
全文读 raw → 抽取实体/概念/断言 → 对照现库 diff（哪些页要新建、哪些要更新、哪些断言与旧页矛盾）。
每次编译前必读三段：SCHEMA.md（约定）→ 当前 INDEX.md（导航）→ 现库页全文。

## SCHEMA.md（层 3 约定 · 必读）

${opts.schemaText}

## INDEX.md（现库导航 · 必读）

${opts.indexText ?? "（首编译：INDEX.md 尚不存在，现库为空——本次产物将建立导航层）"}

## 现库页全文（对照 diff 用 · 必读）

${opts.currentPages.length > 0
    ? opts.currentPages.map(p => `### ${p.relPath}\n\n${p.content}`).join("\n---\n\n")
    : "（首编译：现库无页，所有页均为 create）"}

## raw 源（不可变 · 全文读）

- path: ${opts.raw.path}
- origin: ${opts.raw.origin}
- sha256: ${opts.raw.hash}
- title: ${opts.rawTitle}

${opts.rawContent}

## 输出契约

只输出一个 JSON 对象（可用 \`\`\`json 围栏），不要任何围栏外解释。结构：

${JSON.stringify(contract, null, 2)}

硬性纪律（违反 ⇒ 编译被写闸拒绝）：
1. **锚点发号权在服务侧**：topic 页「硬约束」小节的新祈使句规则行，以 \`${ANCHOR_TOKEN}\` 占位
   （一行一枚）；**禁止手写 oct-NNN 数字**。更新已有 topic 页时，在盘锚点必须原行原样保留。
2. **不静默覆盖**：与旧页断言冲突 ⇒ 进 contradictions 如实上报，旧断言在旧页保留原位；
   不要把旧断言从更新稿里删掉。
3. **sources 回执页由服务程序化生成**，不要放进 pages。
4. 正文零日期；单页 ≤120 行/~2000 token；[[链接]] 与 links 目标必须真实存在（现库或本批）。
5. 页 id 前缀：ent- / con- / top-；文件名默认 {id}.md。`
}

/** ── D-kc15-1（票07）：L5 日期类失败的一轮常青改写自纠 ── */

/**
 * L5 日期类 lint 失败判定（自纠触发面）：WikiLintError 且 findings 含 L5_DATES_IN_BODY。
 * 混合违规（如断链+日期同页）也算日期类——自纠只改日期形态，其余闸第二轮照样全过。
 */
export function isDatesLintFailure(err: unknown): err is WikiLintError {
  return err instanceof WikiLintError && err.findings.some(f => f.code === "L5_DATES_IN_BODY")
}

/** 日期 offender：页 id/标题 + 正文日期命中（与 L5 闸同口径——先剥 [[wikilink]] 再找日期）。 */
export interface DatesOffender {
  id: string
  title: string
  dates: string[]
  body: string
}

/**
 * 常青改写 prompt（自纠 seam 的合同面，独立可测）：只改日期形态，
 * 事实/锚点/链接不动；输出 JSON `{pages:[{id, body}]}`。
 */
export function buildDatesEvergreenPrompt(opts: { offenders: DatesOffender[]; raw: RawPointer }): string {
  const contract = { pages: [{ id: "与输入 offender 同 id", body: "改写后的完整正文（无 front-matter）" }] }
  return `# 常青化自纠（L5_DATES_IN_BODY）

刚才的多页编译被「正文零日期」硬闸拒绝（写闸拒收，零落盘）。
源 \`${opts.raw.path}\` 里带日期（如 ${opts.offenders.flatMap(o => o.dates).slice(0, 4).map(d => `'${d}'`).join(", ") || "…"}），
而常青页正文应零日期——时间事实由本页 front-matter sources、sources 回执页、LOG.md 与 git 历史承接（服务自动维护，正文不必复述）。

对下面每一页输出**改写稿**：
- 把日期表述改写为常青形态（"于 2026-04-02 提出" → "提出"；"2026年10月" → 删除或改"历史上"）
- 只动日期形态：事实、断言、[[链接]]、小节结构保持不变
- **规则锚点 <!--#oct-NNN--> 原行原样保留**（存活锚点不可删改）；禁止输出 oct-NEW 占位
- 改写后正文**不得再出现任何日期形态**（YYYY-MM-DD、YYYY/M/D、YYYY年M月D日）

## 输出契约

只输出一个 JSON 对象（可用 \`\`\`json 围栏），不要任何围栏外解释：

${JSON.stringify(contract, null, 2)}

## 触闸页（逐页给出 id / dates / 现正文）

${opts.offenders.map(o => `### ${o.id}（${o.title}）\n命中日期: ${o.dates.map(d => `'${d}'`).join(", ")}\n\n${o.body}`).join("\n---\n\n")}`
}

/** 解析改写响应：结构不合 ⇒ CURATOR_LLM_JSON（调用方按自纠失败终止，不做第二轮自纠）。 */
export function parseDatesRewrite(text: string): Array<{ id: string; body: string }> {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new CuratorError("CURATOR_LLM_JSON", "自纠改写响应里没有 JSON 对象", 502)
  }
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch (err) {
    throw new CuratorError("CURATOR_LLM_JSON", `自纠改写 JSON 解析失败：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, 502)
  }
  const rec = data as Record<string, unknown>
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.pages)) {
    throw new CuratorError("CURATOR_LLM_JSON", "自纠改写缺少 pages 数组", 502)
  }
  return rec.pages.map((rawPage, i) => {
    const p = rawPage as Record<string, unknown>
    if (typeof p.id !== "string" || !p.id.trim()) {
      throw new CuratorError("CURATOR_LLM_JSON", `自纠改写 pages[${i}] 缺 id`, 502)
    }
    if (typeof p.body !== "string" || !p.body.trim()) {
      throw new CuratorError("CURATOR_LLM_JSON", `自纠改写 pages[${i}]（${p.id}）缺 body`, 502)
    }
    return { id: p.id, body: p.body }
  })
}

/**
 * 矛盾标记（票05 AC3）：append-only 且幂等——正文已含同 finding id 则不重复标记。
 * 标记行放在「## 冲突待裁决」小节（旧断言留在原小节原位 = 不静默覆盖）。
 */
export function appendContradictionMarker(body: string, markerLine: string): string {
  const idM = /【(fnd-[^\]】]+)】/.exec(markerLine)
  if (idM && body.includes(idM[1])) return body
  const SECTION = "## 冲突待裁决"
  if (body.includes(SECTION)) {
    const idx = body.indexOf(SECTION)
    const lineEnd = body.indexOf("\n", idx)
    if (lineEnd === -1) return `${body}\n${markerLine}\n`
    return `${body.slice(0, lineEnd + 1)}${markerLine}\n${body.slice(lineEnd + 1).replace(/^\n+/, "")}`
  }
  return `${body.replace(/\s+$/, "")}\n\n${SECTION}\n${markerLine}\n`
}

export class CuratorCompileService {
  readonly root: string
  readonly wikiRoot: string
  private readonly db: Database.Database
  private readonly llm: LLMCall
  private readonly git?: GitRunner
  private readonly now: () => Date

  constructor(deps: CuratorDeps) {
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = getGlobalWikiRoot(this.root)
    this.db = deps.db
    this.llm = deps.llm
    this.git = deps.git
    this.now = deps.now ?? (() => new Date())
  }

  /** 便利入口：按知识根相对路径取 raw 指针（路由/归档投喂不经票02 返回值时用）。 */
  resolveRawPointer(rawPath: string): RawPointer {
    const abs = this.rawAbs(rawPath)
    let content: string
    try {
      content = fs.readFileSync(abs, "utf-8")
    } catch {
      throw new CuratorError("RAW_NOT_FOUND", `raw 源不在盘：${rawPath}`, 404)
    }
    const m = FRONT_MATTER_RE.exec(content)
    const header = m?.[1] ?? ""
    const hash = headerValue(header, "hash") ?? ""
    const origin = headerValue(header, "origin") ?? ""
    const payload = m ? content.slice(m[0].length) : content
    return { path: rawPath, hash, origin, bytes: Buffer.byteLength(payload, "utf-8") }
  }

  /**
   * 单次编译入口（票06 队列整包的原子单位）：await 完成、无进程内队列/锁语义。
   * raw.path = 知识根相对路径（raw/{inbox,archives,research}/…，票02 RawPointer 口径）。
   */
  async compileRaw(raw: RawPointer): Promise<CuratorCompileResult> {
    const abs = this.rawAbs(raw.path)
    if (!fs.existsSync(abs)) throw new CuratorError("RAW_NOT_FOUND", `raw 源不在盘：${raw.path}`, 404)
    const rawContent = fs.readFileSync(abs, "utf-8")
    const m = FRONT_MATTER_RE.exec(rawContent)
    const header = m?.[1] ?? ""
    const payload = m ? rawContent.slice(m[0].length) : rawContent
    const headerHash = headerValue(header, "hash")
    // 不可变契约对质：指针 hash ↔ 文件头 hash ↔ 实算 payload hash 三方一致
    if (raw.hash !== headerHash) {
      throw new CuratorError("RAW_HASH_MISMATCH", `指针 hash 与 raw 文件头不符：${raw.path}`, 409)
    }
    if (sha256Hex(payload) !== raw.hash) {
      throw new CuratorError("RAW_HASH_MISMATCH", `raw 内容 hash 实算不符（不可变契约被破坏？）：${raw.path}`, 409)
    }
    const rawTitle = headerValue(header, "title") || path.basename(raw.path, ".md")

    // ── 幂等快路径：sources 回执页存在且回指 hash 相符 ⇒ no-op（不调 LLM、零副作用）──
    const stem = path.basename(raw.path, ".md")
    const sourcesRel = `sources/${stem}.md`
    const sourcesAbs = path.join(this.wikiRoot, sourcesRel)
    if (fs.existsSync(sourcesAbs)) {
      const existing = fs.readFileSync(sourcesAbs, "utf-8")
      if (existing.includes(raw.hash)) {
        return this.dedupedResult(raw, rawTitle, existing)
      }
    }

    // ── 编译前必读：SCHEMA.md（先幂等 seed）→ INDEX.md → 现库页全文 ──
    ensureKnowledgeSkeleton(this.root)
    ensureSchemaDoc(this.root)
    const schemaText = fs.readFileSync(path.join(this.root, SCHEMA_DOC_FILE), "utf-8")
    const indexAbs = path.join(this.wikiRoot, "INDEX.md")
    const indexText = fs.existsSync(indexAbs) ? fs.readFileSync(indexAbs, "utf-8") : null
    const scanned = scanWikiEntries(this.wikiRoot)
    const currentPages = scanned.map(e => ({
      relPath: e.relPath,
      content: fs.readFileSync(path.join(this.wikiRoot, e.relPath), "utf-8"),
    }))

    // ── LLM 抽取（seam；provider 缺席/禁用返回空串 ⇒ LLM_UNAVAILABLE）──
    const prompt = buildCuratorPrompt({ schemaText, indexText, currentPages, raw, rawTitle, rawContent })
    const response = await this.llm(prompt)
    if (!response || response.trim() === "") {
      throw new CuratorError("LLM_UNAVAILABLE", "策展 LLM 无响应（provider 缺席或被禁用），编译未开始、零副作用", 503)
    }
    let plan: CuratorPlan
    let selfCorrected = false
    try {
      plan = parseCuratorPlan(response)
    } catch (err) {
      // 计划校验不过 ⇒ 带错自纠一轮（spec 故事23「机械问题对话内自纠」的服务侧等价；
      // 真 provider 实跑实证：模型会偶发 volatile 缺 review_after 之类的形态违规）。
      // 仍失败 ⇒ 原样抛出（CURATOR_LLM_JSON），零副作用终止，不做无限重试。
      if (!(err instanceof CuratorError) || err.code !== "CURATOR_LLM_JSON") throw err
      const repairPrompt = `${prompt}\n\n# 上一次输出校验失败（必须修正后重新输出完整 JSON 计划）\n错误：${err.message}\n务必满足：volatile 页带 review_after（YYYY-MM-DD，此日期允许出现在 JSON 字段而非正文）；其余纪律同上。`
      const retry = await this.llm(repairPrompt)
      if (!retry || retry.trim() === "") throw err
      plan = parseCuratorPlan(retry)
      selfCorrected = true
    }

    // ── 对照现 wiki diff：id 在盘=update / 缺席=create；锚点服务发号 ──
    const today = this.now().toISOString().slice(0, 10)
    interface PageWork { relPath: string; fileName?: string; meta: WikiPageFrontmatter; body: string; created: boolean }
    const works: PageWork[] = []
    const issuedAnchors: string[] = []
    for (const p of plan.pages) {
      const existing = scanned.find(e => e.meta.id === p.id)
      const fileName = existing ? existing.relPath.split("/").pop() ?? `${p.id}.md` : undefined
      const derivedOp = existing ? "update" : "create"
      if (p.op === "update" && !existing) {
        throw new CuratorError("CURATOR_PLAN_TARGET_MISSING", `计划声明 update 但 id '${p.id}' 不在现库——请先确认页在盘`, 400)
      }
      let body = p.body
      // oct-NEW 占位 → 服务发号（nextRuleAnchor 全库 max+1；批内已发号入 extra 防双花）
      while (body.includes(ANCHOR_TOKEN)) {
        const anchor = nextRuleAnchor(this.wikiRoot, issuedAnchors)
        issuedAnchors.push(anchor)
        body = body.replace(ANCHOR_TOKEN, `<!--#${anchor}-->`)
      }
      // update 页：在盘锚点必须原样保留（永不复用/丢失 ⇒ wiki_refs 引用不断链）
      if (existing) {
        const oldAnchors = existing.anchors
        const newAnchors = new Set(extractRuleAnchors(body))
        const lost = oldAnchors.filter(a => !newAnchors.has(a))
        if (lost.length > 0) {
          throw new CuratorError("CURATOR_ANCHOR_REGRESSION", `更新 ${existing.relPath} 丢失在盘锚点 ${lost.join(", ")}——存活规则锚点不可删改`, 400)
        }
      }
      const sources = [...new Set([...(existing?.meta.sources ?? []), raw.path])]
      const meta: WikiPageFrontmatter = {
        id: p.id,
        type: p.type,
        ...(p.type === "entity" && p.entity_kind ? { entity_kind: p.entity_kind } : {}),
        title: p.title,
        summary: p.summary,
        topics: p.topics ?? [],
        aliases: p.type === "entity" ? p.aliases ?? [] : p.aliases ?? [],
        links: [...new Set(p.links ?? [])],
        ...(p.stability ? { stability: p.stability } : {}),
        ...(p.review_after ? { review_after: p.review_after } : {}),
        last_compiled: today,
        sources,
        ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      }
      works.push({ relPath: `${pageDirForType(p.type)}/${fileName ?? `${p.id}.md`}`, ...(fileName ? { fileName } : {}), meta, body, created: derivedOp === "create" })
    }

    // ── 矛盾处置（票05 AC3）：两页内标记 + finding 行；不静默覆盖、不阻塞编译 ──
    // 标记含确定性 finding id（内容寻址，重跑同矛盾同 id ⇒ appendMarker 天然幂等）。
    // 旧页若不在批内：整页拉进批（body 原样 + 标记节，旧断言逐字保留原位 = 不覆盖）。
    const findings: Array<Parameters<FindingsDAO["upsert"]>[0]> = []
    for (const c of plan.contradictions ?? []) {
      const newWork = works.find(w => w.meta.id === c.new_page)
      if (!newWork) {
        throw new CuratorError("CURATOR_PLAN_TARGET_MISSING", `contradiction.new_page '${c.new_page}' 不在本批计划页里`, 400)
      }
      let oldWork = works.find(w => w.relPath === c.old_page || w.meta.id === c.old_page)
      if (!oldWork) {
        const oldEntry = scanned.find(e => e.relPath === c.old_page || e.meta.id === c.old_page)
        if (!oldEntry) {
          throw new CuratorError("CURATOR_PLAN_TARGET_MISSING", `contradiction.old_page '${c.old_page}' 既不在现库也不在本批计划里`, 400)
        }
        const parsed = parseWikiFile(fs.readFileSync(path.join(this.wikiRoot, oldEntry.relPath), "utf-8"))
        if (parsed.kind !== "page") {
          throw new CuratorError("CURATOR_CONTRADICTION_TARGET_LEGACY", `旧页 ${oldEntry.relPath} 是 v2 形态，矛盾标记需 v3 页（重蒸馏属票07；先蒸馏再投喂此源）`, 409)
        }
        oldWork = {
          relPath: oldEntry.relPath,
          fileName: oldEntry.relPath.split("/").pop(),
          meta: {
            ...parsed.meta,
            last_compiled: today,
            sources: [...new Set([...parsed.meta.sources, raw.path])],
          },
          body: parsed.body,
          created: false,
        }
        works.push(oldWork)
      }
      const findingId = `fnd-${sha256Hex(`contradiction|${raw.hash}|${c.old_page}|${c.new_page}|${c.old_claim}|${c.new_claim}`).slice(0, 16)}`
      // 标记行禁带 raw 路径（路径含日期 ⇒ L5 正文禁日期闸；常青页不豁免）——对质指针 =
      // hash 前缀 + 本页 front-matter sources（两页的 sources 都已并入 raw.path，闭环在）
      const rawRef = `sha256 ${raw.hash.slice(0, 12)}…（对质指针见本页 front-matter sources）`
      oldWork.body = appendContradictionMarker(
        oldWork.body,
        `> 【${findingId}】与 [[${c.new_page}]]（${newWork.relPath}）冲突：旧断言「${c.old_claim}」↔ 新源断言「${c.new_claim}」。旧断言保留未覆盖——裁决（采纳修订/忽略/讨论）在知识中心对话进行；对质源 ${rawRef}`,
      )
      newWork.body = appendContradictionMarker(
        newWork.body,
        `> 【${findingId}】与旧页 ${oldWork.relPath} 冲突：旧断言「${c.old_claim}」↔ 新断言「${c.new_claim}」。旧断言原位保留未覆盖——待裁决（采纳修订/忽略/讨论）；对质源 ${rawRef}`,
      )
      findings.push({
        id: findingId,
        kind: "contradiction",
        title: `矛盾：${oldWork.relPath} ↔ ${newWork.relPath}`,
        detail: JSON.stringify({ old_claim: c.old_claim, new_claim: c.new_claim, old_page: oldWork.relPath, new_page: newWork.relPath, raw: { path: raw.path, hash: raw.hash } }),
        pages: JSON.stringify([oldWork.relPath, newWork.relPath]),
        raw_ref: raw.path,
        source: "compile",
      })
    }

    // ── sources 回执页（程序化：要点 + 触及页清单 + 回指 raw 路径与 hash）──
    const srcId = `src-${stem}`
    const srcExisting = scanned.find(e => e.meta.id === srcId)
    const keyPoints = plan.key_points ?? []
    const touchedList = works.map(w => ({ path: w.relPath, type: w.meta.type, created: w.created }))
    const srcBody = [
      "## 要点",
      ...(keyPoints.length > 0 ? keyPoints.map(k => `- ${k}`) : ["- （模型未给出要点清单）"]),
      "",
      "## 触及页清单",
      ...touchedList.map(t => `- [[${t.path.replace(/\.md$/, "").split("/").pop() ?? t.path}]]（${t.path}·${t.type}${t.created ? "·新建" : "·更新"}）`),
      `- 本回执页：${srcExisting?.relPath ?? sourcesRel}`,
      "",
      "## 回指 raw（不可变源 · 对质凭据）",
      `- raw: ${raw.path}`,
      `- sha256: ${raw.hash}`,
      `- origin: ${raw.origin}`,
      "",
    ].join("\n")
    const srcMeta: WikiPageFrontmatter = {
      id: srcId,
      type: "source",
      title: `${rawTitle} — 来源摘要`,
      summary: `编译回执：要点 ${keyPoints.length} 条 · 触及 ${touchedList.length + 1} 页 · 回指 ${raw.path}`,
      topics: [],
      aliases: [],
      links: touchedList.map(t => t.path.replace(/\.md$/, "").split("/").pop() ?? t.path),
      last_compiled: today,
      sources: [raw.path],
    }

    // ── 单一写闸批通道：N 页 + INDEX/LOG/FTS/git 一个 commit，失败回滚零半成品 ──
    const compiler = new WikiCompileService({ db: this.db, org: GLOBAL_WIKI_ORG, rootDir: this.wikiRoot, ...(this.git ? { git: this.git } : {}) })
    const created = touchedList.filter(t => t.created).length + (srcExisting ? 0 : 1)
    const buildBatch = (): BatchPageInput[] => {
      const b: BatchPageInput[] = works.map(w => (w.fileName ? { content: serializePageMarkdown(w.meta, w.body), fileName: w.fileName } : { content: serializePageMarkdown(w.meta, w.body) }))
      b.push({ content: serializePageMarkdown(srcMeta, srcBody), fileName: `${stem}.md` })
      return b
    }
    const batchOpts = {
      action: "ingest" as const,
      entry: rawTitle,
      note: `触 ${works.length + 1} 页 · 新页 ${created} · 矛盾 ${findings.length} · raw ${raw.path}`,
      source: raw.path,
      reviewer: "curator",
    }

    // ── D-kc15-1（票07）：L5 日期类失败 ⇒ 服务层一轮常青改写自纠 ⇒ 重编译 ──
    // 缺陷现场（KC e2e-report）：含日期的一手源（最常见的真实素材）恒失败于 L5_DATES_IN_BODY——
    // 真模型反复把源内日期抄进常青概念页。自纠纪律：**一轮上限**（仍败即终态 failed + 痕迹可查，
    // 不无限重试）；**闸不放松**——改写产物重新整批走同一 compilePages 全量闸（L1~L6 一视同仁）；
    // 改写只动日期形态（锚点丢失/oct-NEW 混入即弃用改写，保持原判）。非日期类失败原样上抛。
    let res: BatchCompileResult
    let datesCorrectedIds: string[] | null = null
    try {
      res = await compiler.compilePages(buildBatch(), batchOpts)
    } catch (err) {
      if (!isDatesLintFailure(err)) throw err
      const offenders: DatesOffender[] = []
      for (const w of works) {
        if (!lintProfileForPageType(w.meta.type).datesInBody) continue // source/case 页天然带日期（豁免面）
        const dates = findDateOccurrences(w.body.replace(WIKILINK_RE, ""))
        if (dates.length > 0) offenders.push({ id: w.meta.id, title: w.meta.title, dates, body: w.body })
      }
      if (offenders.length === 0) throw err // 闸报日期而逐页检测无命中 ⇒ 不臆测，保持原判
      const trace = `日期常青自纠一轮（触闸页 ${offenders.map(o => o.id).join(", ")}）`
      const abort = (reason: string): never => {
        // 终态 failed：原判闸行 + 自纠痕迹 + 败因（任务记录 error.message 可查）
        throw new Error(`${err.message}——${trace}仍未过闸：${reason}`)
      }
      const rewriteResponse = await this.llm(buildDatesEvergreenPrompt({ offenders, raw }))
      if (!rewriteResponse || rewriteResponse.trim() === "") abort("自纠 LLM 无响应（provider 缺席/禁用）")
      let rewrites: Array<{ id: string; body: string }>
      try {
        rewrites = parseDatesRewrite(rewriteResponse)
      } catch (pe) {
        abort(pe instanceof Error ? pe.message : String(pe))
      }
      const byId = new Map(rewrites.map(r => [r.id, r.body]))
      for (const w of works) {
        if (!offenders.some(o => o.id === w.meta.id)) continue
        const nb = byId.get(w.meta.id)
        if (nb === undefined || !nb.trim()) abort(`改写响应缺 ${w.meta.id} 可用正文`)
        const lost = extractRuleAnchors(w.body).filter(a => !extractRuleAnchors(nb).includes(a))
        if (lost.length > 0) abort(`改写丢失在盘锚点 ${lost.join(", ")}`)
        if (nb.includes(ANCHOR_TOKEN)) abort(`改写混入 ${ANCHOR_TOKEN} 占位（发号权在服务侧）`)
        w.body = nb
      }
      try {
        res = await compiler.compilePages(buildBatch(), batchOpts)
      } catch (e2) {
        abort(`第二轮写闸拒绝：${e2 instanceof Error ? e2.message : String(e2)}`)
      }
      datesCorrectedIds = offenders.map(o => o.id)
    }

    // findings 落库在 commit 成功之后——回滚掉的编译不许留下发现（零半成品纪律）
    const findingsDao = new FindingsDAO(this.db)
    for (const f of findings) findingsDao.upsert(f)

    return {
      rawPath: raw.path,
      rawHash: raw.hash,
      rawTitle,
      touched: res.pages.map(pg => ({ path: pg.path, type: pg.type, created: pg.created })),
      created: res.pages.filter(pg => pg.created).length,
      updated: res.pages.filter(pg => !pg.created).length,
      contradictions: findings.length,
      findingIds: findings.map(f => f.id),
      commit: res.commit,
      changed: res.changed,
      deduped: false,
      warnings: [
        ...(selfCorrected ? ["计划校验失败一次，已带错自纠重编译（第二轮过闸）"] : []),
        ...(datesCorrectedIds ? [`日期常青自纠一轮（改写页 ${datesCorrectedIds.join(", ")}），产物仍全量过 lint 闸`] : []),
        ...res.pages.flatMap(pg => pg.warnings),
      ],
    }
  }

  /**
   * raw 路径解析：只认知识根相对的 POSIX `raw/...` 路径（票02 RawPointer.path 口径）。
   * 绝对路径/逃逸（..、盘符）一律 INVALID_PARAM——编译通道对 raw 只读且不许越界读。
   */
  private rawAbs(rawPath: string): string {
    const clean = rawPath.replace(/\\/g, "/")
    if (!clean.startsWith("raw/")) {
      throw new CuratorError("INVALID_PARAM", `raw 路径须以 'raw/' 开头（知识根相对）：${rawPath}`, 400)
    }
    const rawRoot = path.resolve(this.root, "raw")
    const abs = path.resolve(this.root, clean)
    if (!abs.startsWith(rawRoot + path.sep)) {
      throw new CuratorError("INVALID_PARAM", `raw 路径逃逸知识根 raw/：${rawPath}`, 400)
    }
    return abs
  }

  private dedupedResult(raw: RawPointer, rawTitle: string, sourcesContent: string): CuratorCompileResult {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(sourcesContent)
    const links: string[] = []
    if (m) {
      const l = m[1].split("\n").find(x => x.startsWith("links:"))
      if (l) for (const mm of l.matchAll(/\[([a-z0-9-]+)\]/g)) links.push(mm[1])
    }
    const scanned = scanWikiEntries(this.wikiRoot)
    const touched: CuratorTouchedPage[] = []
    for (const id of links) {
      const e = scanned.find(s => s.meta.id === id)
      if (e) touched.push({ path: e.relPath, type: e.type, created: false })
    }
    const src = scanned.find(e => e.relPath === `sources/${path.basename(raw.path, ".md")}.md`)
    if (src) touched.push({ path: src.relPath, type: "source", created: false })
    return {
      rawPath: raw.path,
      rawHash: raw.hash,
      rawTitle,
      touched,
      created: 0,
      updated: 0,
      contradictions: 0,
      findingIds: [],
      commit: null,
      changed: false,
      deduped: true,
      warnings: [],
    }
  }
}

