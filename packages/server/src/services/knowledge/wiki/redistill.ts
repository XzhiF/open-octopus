import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter, WikiPageFrontmatter } from "@octopus/shared"
import { GLOBAL_WIKI_ORG, resolveGlobalWikiRoot } from "../global-paths"
import { parseWikiFile, extractRuleAnchors, serializePageMarkdown, RULE_ANCHOR_RE } from "./format"
import { REDISTILL_MAP_REL, WIKI_DOMAINS } from "./paths"
import { parseH2Sections, lintWikiPage, TOPIC_CONSTRAINTS_SECTION } from "./lint"
import type { WriteQueue } from "./compile-queue"
import { WikiCompileService, WIKI_LOG_HEADER, scanWikiEntries, type BatchPageInput } from "./compile"
import { WikiArticleDAO } from "../../../db/dao/wiki-article-dao"

export { REDISTILL_MAP_REL }

/**
 * wiki v2→v3 重蒸馏迁移（知识中心票07，spec §迁移与幂等「重蒸馏映射」/ stories 34-35）—
 * 单入口幂等命令，形制同票03 global-move（默认 dry-run 只读列计划，`apply=true` 才动手）：
 *
 *   映射执行（纯机械，零 LLM——重蒸馏是 taxonomy 换代不是语义策展，owner 可审）：
 *   - projects/workflows 词条 → topics 页：id 保号、规则行入「## 硬约束」小节、
 *     锚点 `<!--#oct-NNN-->` 原号随迁（历史 wiki_refs `词条id#锚点` 直接可解析）
 *   - business 词条 → concepts 页；Glossary 蒸馏产物（summary 钉 `GLOSSARY-MAP 存量收编 ·
 *     {pkg}`）按 pkg 归并对应概念页（base chunk 保号，-N 分片并入 mergedFrom）；
 *     **容量感知装页**：术语按 分片序×行序 贪心装页，以 lintWikiPage L1 闸做判据
 *     （闸本体=唯一真相，不重算阈值），超限自动续页 `{base}-p2/-p3`（真语料 server 域
 *     39 术语≈2700 token > L1 2000，纯单页归并会被写闸整批拒绝——装页器消解该病灶）
 *   - research 词条 → concepts 页（source 回执页是票05 raw 编译管线的产物，重蒸馏不伪造——
 *     偏离决策见票报告）
 *   - cases 原样保留（文件不动；DB type 值切 'case' 属 re-key 段）
 *   - 非 topic 页按 v3 锚点小节铁律（lint L5_ANCHOR_SCOPE）不落锚点注释：剥落的锚点
 *     原号进对照表台账（carried=false），永不复用由 nextRuleAnchor 读台账保证
 *   - 旧词条文件整迁 `_retired/v2/{domain}/`（不删除；hub 子目录形态出现即
 *     REDISTILL_UNSUPPORTED_HUB 硬拒交人工裁决）
 *   - [[链接]] 机械改写：指向 v2 旧路径/被并 chunk id 的目标改指新页（断链零；分片
 *     跨页时指向其**首个**落页，先到先得）
 *   - LOG.md 旧表格行机械转换 `## [date] op | title → 结果` 行格式（原表封 git 史）
 *   - INDEX.md 程序化重建五类分组（写闸 compilePages 内 renderBudgetedWikiIndex 单源）
 *   - DB wiki_articles type 值切五类 + FTS 重建（蓝绿派生自现 DDL），行数对账不丢
 *   - 全部落盘 = 一个 git commit（整体 revert 可还原）；重跑 diff 为空（幂等）。
 *
 * 票06 写串行：构造注入 queue（生产 = index.ts wikiWriteQueue 单例，带 wiki 根锁）时，
 * apply 的整个写段以 kind "redistill" 入全局 FIFO 队列执行（spec §全局写串行「统一入队、
 * 禁旁路」）；ops 同步回报形态 = 入队后轮询终态。dry-run 零写盘不入队。
 *
 * 真数据纪律（铁律同 global-move）：只被显式调用（POST /api/knowledge/wiki/redistill）；
 * 前置 = 票03 真搬家已跑（全局根 + org 钉 global）；apply 前主控先按 backupHint 备份 DB。
 *
 * 写入收口：v3 页产物一律经唯一写闸 WikiCompileService.compilePages 批通道落盘
 * （lint/L4 预算/INDEX/LOG/DB/FTS/commit 全闸免费获得）；本模块自己的前置步
 * （旧页迁移/台账/LOG 换格式）在闸外做但共享同一失败补偿路径——任何异常先把
 * 前置步还原再重抛，闸自身的回滚由 compilePages 内部快照完成。
 */

/** v2 四域目录（cases 不在映射输入面——判例原样保留，不迁不写）。 */
const V2_SOURCE_DOMAINS = WIKI_DOMAINS.filter(d => d !== "cases")

export type RedistillAction = "topic" | "concept" | "merged-concept"

export interface RedistillPagePlan {
  /** 映射源的词条 id（merged/续页时 = 该页首个贡献 chunk id） */
  oldId: string
  /** v2 相对路径，如 workflows/wf-prd-impl.md */
  oldPath: string
  newId: string
  /** v3 相对路径，如 topics/wf-prd-impl.md */
  newPath: string
  action: RedistillAction
  /** merged-concept：该页吸收的分片 id（跨页分属多页） */
  mergedFrom?: string[]
}

export interface RedistillAnchorEntry {
  /** v2 形态 wiki_ref：`{词条id}#{锚点}` */
  ref: string
  anchor: string
  oldPath: string
  /** 新页相对路径（可解析断言的目标面） */
  newPath: string
  /** true = 锚点注释原号原样在 newPage「硬约束」小节；false = 剥落入台账（永不复用） */
  carried: boolean
}

export interface RedistillReport {
  dryRun: boolean
  changed: boolean
  reason?: string
  pages: RedistillPagePlan[]
  retired: Array<{ from: string; to: string }>
  anchors: RedistillAnchorEntry[]
  log: { tableRows: number }
  db: {
    beforeTotal: number
    afterTotal?: number
    byType?: Record<string, number>
    deleted?: Array<{ id: string; mergedInto: string }>
  }
  commit: string | null
  backupHint: string
  /** 经票06 全局写队列执行时的任务 id（queue/task/:id 可查；直跑模式无此字段） */
  queueTaskId?: string
}

export interface RedistillOptions {
  db: Database.Database
  /** false（默认）= dry-run 只读列计划；true = 执行（写页/迁旧/LOG/INDEX/DB/commit） */
  apply?: boolean
  /** 全局 wiki 根覆盖（缺省 resolveGlobalWikiRoot()；测试注入 tmpdir fixture） */
  wikiRoot?: string
  /** DB org 钉值（缺省 'global'，票03 re-key 后语义） */
  org?: string
  /**
   * 票06 全局写串行队列（spec §全局写串行：重蒸馏入队，禁旁路）。生产注入 server
   * wikiWriteQueue（自带 wiki 根 .compile.lock 跨进程保底）；缺省 = 直跑（测试/无队列环境）。
   */
  queue?: WriteQueue
}

/** 队列终态等待上限：锁等待 5min（wiki-lock）+ 队首前序写操作最坏时长余量；超时硬错交重查队列路由。 */
const REDISTILL_QUEUE_WAIT_LIMIT_MS = 10 * 60_000
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Glossary 蒸馏产物判据（migrate.ts 产物的 summary 钉格式，真语料逐字吻合）。 */
const GLOSSARY_SUMMARY_RE = /^GLOSSARY-MAP 存量收编(?: · (.+))?$/

/** chunk 文件名后缀 `-N`（同 pkg 分片；base 无后缀 ⇒ 0）。 */
function chunkIndex(id: string, pkg: string): number {
  const prefix = `biz-glossary-${pkg}`
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : id
  const m = /^-(\d+)$/.exec(rest)
  return m ? Number(m[1]) : 0
}

export interface V2Entry {
  relPath: string
  meta: WikiEntryFrontmatter
  body: string
}

/**
 * 读 v2 存量词条（深度一层；发现 hub 子目录即硬拒——机械映射未定义 hub 形态）。
 * 已属 v3 形态（type）的文件跳过（重蒸馏幂等段的自然结果）。
 */
export function readV2Entries(root: string): V2Entry[] {
  const out: V2Entry[] = []
  for (const dir of V2_SOURCE_DOMAINS) {
    const abs = path.join(root, dir)
    let names: string[] = []
    try {
      names = fs.readdirSync(abs).sort()
    } catch {
      continue // 目录不存在（骨架未建）⇒ 无可迁对象
    }
    for (const name of names) {
      const full = path.join(abs, name)
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        const kids = fs.readdirSync(full).filter(n => n.endsWith(".md"))
        if (kids.length > 0) {
          throw new Error(`REDISTILL_UNSUPPORTED_HUB: '${dir}/${name}/' 是 hub 子目录形态——重蒸馏机械映射未定义 hub，请先人工拆并或按票05 hub 通道处理`)
        }
        continue
      }
      if (!name.endsWith(".md")) continue
      const parsed = parseWikiFile(fs.readFileSync(full, "utf-8"))
      if (parsed.kind !== "entry") continue // v3 页/判例混放：不进映射面
      out.push({ relPath: `${dir}/${name}`, meta: parsed.meta, body: parsed.body })
    }
  }
  return out
}

// ── 正文机械变换 ─────────────────────────────────────────────

/** 剥除行尾锚点注释（含其前置空白）。 */
function stripAnchorComment(line: string): string {
  return line.replace(/ ?<!--#[A-Za-z0-9_-]+-->/g, "").replace(/\s+$/, "")
}

interface Decomposed {
  preamble: string[]
  /** 原 H2 小节剥掉规则行后的剩余内容行 */
  sections: Array<{ title: string; lines: string[] }>
  /** 锚点规则行（原文含锚点注释），文档序 */
  rules: string[]
}

function decomposeBody(body: string): Decomposed {
  const { preamble, sections } = parseH2Sections(body)
  const rules: string[] = []
  const pre: string[] = []
  const rest: Array<{ title: string; lines: string[] }> = []
  for (const l of preamble) {
    if (RULE_ANCHOR_RE.test(l)) rules.push(l)
    else if (l.trim()) pre.push(l)
  }
  for (const s of sections) {
    const lines: string[] = []
    for (const l of s.lines) {
      if (RULE_ANCHOR_RE.test(l)) rules.push(l)
      else if (l.trim()) lines.push(l)
    }
    if (lines.length > 0) rest.push({ title: s.title, lines })
  }
  return { preamble: pre, sections: rest, rules }
}

function assemble(blocks: string[]): string {
  return blocks.filter(b => b.trim().length > 0).join("\n\n") + "\n"
}

/** topic 页正文：规则行集中入「硬约束」小节（锚点注释原样保留），其余内容按原小节保序。 */
export function buildTopicBody(body: string): string {
  const { preamble, sections, rules } = decomposeBody(body)
  const blocks = [preamble.join("\n"), ...sections.map(s => `## ${s.title}\n${s.lines.join("\n")}`)]
  if (rules.length > 0) blocks.push(`## ${TOPIC_CONSTRAINTS_SECTION}\n${rules.join("\n")}`)
  return assemble(blocks)
}

/** concept/source 正文：结构与文本原样，仅剥锚点注释（v3 L5_ANCHOR_SCOPE：非 topic 不落锚点）。 */
export function buildConceptBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(stripAnchorComment)
    .join("\n")
}

/**
 * [[链接]] 机械改写表：v2 旧路径/旧 id → 新路径/新 id。
 * 值形态跟随键形态：路径式目标 → 新路径（无 .md，resolveWikiLink 补），裸 id 目标 → 新 id。
 * 先到先得：chunk 跨续页时映射到其首个落页（putOnce 语义）。
 */
function buildLinkMap(planned: Array<{ plan: RedistillPagePlan; sources: V2Entry[] }>): Map<string, string> {
  const map = new Map<string, string>()
  const putOnce = (oldKey: string, newKey: string): void => {
    if (!map.has(oldKey)) map.set(oldKey, newKey)
    if (!map.has(`${oldKey}.md`)) map.set(`${oldKey}.md`, `${newKey}.md`)
  }
  for (const { plan, sources } of planned) {
    const newNoMd = plan.newPath.replace(/\.md$/, "")
    putOnce(plan.oldPath.replace(/\.md$/, ""), newNoMd)
    putOnce(plan.oldId, plan.newId)
    for (const src of sources) {
      if (src.meta.id === plan.newId) continue
      putOnce(src.relPath.replace(/\.md$/, ""), newNoMd)
      putOnce(src.meta.id, plan.newId)
    }
  }
  return map
}

export function rewriteWikiLinks(body: string, linkMap: Map<string, string>): string {
  return body.replace(/\[\[([^\]|#]+)((?:[#|][^\]]*)?)\]\]/g, (whole, target: string, rest: string) => {
    const t = target.trim().replace(/\/+$/, "")
    const noMd = t.replace(/\.md$/, "")
    const mapped = linkMap.get(noMd)
    if (mapped === undefined) return whole
    const value = t.endsWith(".md") ? `${mapped}.md` : mapped
    return `[[${value}${rest}]]`
  })
}

/** v3 页 front-matter：v2 元数据原样承接（id 保号面），type 换代、links 由正文改写后留空数组。 */
function pageMetaFrom(e: V2Entry, type: "topic" | "concept", groupSources: V2Entry[]): WikiPageFrontmatter {
  const union = (pick: (m: WikiEntryFrontmatter) => string[]): string[] => {
    const out: string[] = []
    for (const s of groupSources) for (const v of pick(s.meta)) if (!out.includes(v)) out.push(v)
    return out
  }
  return {
    id: e.meta.id,
    type,
    aliases: [],
    title: e.meta.title,
    summary: e.meta.summary,
    topics: union(m => m.topics),
    links: [],
    stability: e.meta.stability,
    ...(e.meta.review_after ? { review_after: e.meta.review_after } : {}),
    last_compiled: e.meta.last_compiled,
    sources: union(m => m.sources),
    confidence: e.meta.confidence,
  }
}

// ── 计划构造（结构计划 → linkMap → 终稿内容，两趟；计划即真相）────────────

/** 装页单元：一条术语行 + 其来源词条（锚点台账按术语实际落页登记）。 */
interface PackedTerm {
  /** 剥锚后的术语行文本 */
  line: string
  src: V2Entry
}

/** 组内一页（装页器产物）。 */
interface PackedGroupPage {
  newId: string
  newPath: string
  pageNum: number
  terms: PackedTerm[]
  /** 非术语散句（仅首页承接） */
  others: string[]
  /** 贡献本组的分片全集（meta union 用） */
  group: V2Entry[]
  /** 本页贡献分片（≠ newId 者入 mergedFrom） */
  contributors: V2Entry[]
}

/** 计划条目 = 映射计划 + 源词条 + 终稿页内容。 */
export interface PlannedPage {
  plan: RedistillPagePlan
  sources: V2Entry[]
  /** 定稿 v3 页内容（front-matter + 正文，[[链接]] 已改写；闸内只做校验与落盘） */
  content: string
}

export interface RedistillPlan {
  planned: PlannedPage[]
  pages: RedistillPagePlan[]
  anchors: RedistillAnchorEntry[]
  retired: Array<{ from: string; to: string }>
}

/** glossary 概念页的候选序列化（装页判据与终稿共用一个构造器，单源呈现）。 */
function glossaryPageContent(base: V2Entry, group: V2Entry[], page: Pick<PackedGroupPage, "newId" | "pageNum">, terms: PackedTerm[], others: string[]): { meta: WikiPageFrontmatter; body: string } {
  const meta = pageMetaFrom(base, "concept", group)
  meta.id = page.newId
  if (page.pageNum > 1) meta.title = `${meta.title}（${page.pageNum}）`
  const blocks = [others.length > 0 ? `## 说明\n${others.join("\n")}` : "", terms.length > 0 ? `## 术语\n${terms.map(t => t.line).join("\n")}` : ""]
  return { meta, body: assemble(blocks) }
}

/**
 * 容量感知装页：术语按 分片序×行序 贪心入页，候选页过 lintWikiPage（闸本体判据，
 * 不重算阈值）出现 L1_CAPACITY 即续页 `{base}-p{N}`。单条术语自身超限 → 独占一页后
 * 交给写闸硬拒（fail-closed，可读错文指路人工拆并）。断链类 error 不参与续页决策
 * （链接改写发生在装页之后的统一 pass）。
 */
function packGlossaryGroup(pkg: string, ordered: V2Entry[], root: string): PackedGroupPage[] {
  const base = ordered.find(e => chunkIndex(e.meta.id, pkg) === 0) ?? ordered[0]
  const baseId = chunkIndex(base.meta.id, pkg) === 0 ? base.meta.id : `biz-glossary-${pkg}`
  const items: PackedTerm[] = []
  const seen = new Set<string>()
  const others: string[] = []
  for (const e of ordered) {
    const { preamble, sections, rules } = decomposeBody(e.body)
    for (const l of rules) {
      const t = stripAnchorComment(l)
      if (!t) continue
      if (!seen.has(t)) {
        seen.add(t)
        items.push({ line: t, src: e })
      }
    }
    for (const l of preamble) if (!others.includes(l)) others.push(l)
    for (const s of sections) for (const l of s.lines) if (!others.includes(l)) others.push(l)
  }

  const pages: PackedGroupPage[] = []
  let cur: PackedGroupPage = { newId: baseId, newPath: `concepts/${baseId}.md`, pageNum: 1, terms: [], others, group: ordered, contributors: [] }
  const overCapacity = (candidate: PackedGroupPage): boolean => {
    const { meta, body } = glossaryPageContent(base, ordered, { newId: candidate.newId, pageNum: candidate.pageNum }, candidate.terms, candidate.others)
    const lint = lintWikiPage({ meta, body, anchors: [], root, linkCorpus: [{ id: meta.id, path: candidate.newPath }] })
    return lint.errors.some(e => e.code === "L1_CAPACITY")
  }
  for (const item of items) {
    const candidate: PackedGroupPage = { ...cur, terms: [...cur.terms, item] }
    if (cur.terms.length > 0 && overCapacity(candidate)) {
      pages.push(cur)
      const nextNum = pages.length + 1
      const nextId = `${baseId}-p${nextNum}`
      cur = { newId: nextId, newPath: `concepts/${nextId}.md`, pageNum: nextNum, terms: [], others: [], group: ordered, contributors: [] }
    }
    cur.terms.push(item)
    if (!cur.contributors.includes(item.src)) cur.contributors.push(item.src)
  }
  pages.push(cur)
  return pages
}

/** 映射计划（纯函数，dry-run 与 apply 共用同一份——计划即真相）。 */
export function planMappings(entries: V2Entry[], lintRoot = ""): RedistillPlan {
  const planned: PlannedPage[] = []
  const retired: Array<{ from: string; to: string }> = []
  const anchors: RedistillAnchorEntry[] = []

  // glossary 分组：pkg → 分片（base 优先、chunk 按 -N 升序）
  const groups = new Map<string, V2Entry[]>()
  const standalone: V2Entry[] = []
  for (const e of entries) {
    const summary = e.meta.summary.trim()
    const gm = GLOSSARY_SUMMARY_RE.test(summary) && e.meta.domain === "business" ? GLOSSARY_SUMMARY_RE.exec(summary) : null
    if (!gm) {
      standalone.push(e)
      continue
    }
    const pkg = gm[1] ?? (e.meta.topics.find(t => t !== "glossary") ?? e.meta.id)
    const g = groups.get(pkg) ?? []
    g.push(e)
    groups.set(pkg, g)
  }

  // ── pass 1：结构计划（非 glossary 1:1；glossary 组容量装页）──────────
  interface GroupPlanItem { base: V2Entry; ordered: V2Entry[]; pages: PackedGroupPage[] }
  const groupPlans: GroupPlanItem[] = []
  for (const [pkg, g] of [...groups.entries()].sort()) {
    const ordered = [...g].sort((a, b) => chunkIndex(a.meta.id, pkg) - chunkIndex(b.meta.id, pkg) || a.meta.id.localeCompare(b.meta.id))
    const pages = packGlossaryGroup(pkg, ordered, lintRoot)
    const base = ordered.find(e => chunkIndex(e.meta.id, pkg) === 0) ?? ordered[0]
    groupPlans.push({ base, ordered, pages })
  }

  // 结构条目（先非 glossary——linkMap/终稿两趟共用）
  interface Structure { plan: RedistillPagePlan; sources: V2Entry[]; kind: "plain" | "glossary"; glossaryRef?: { item: GroupPlanItem; page: PackedGroupPage } }
  const structures: Structure[] = []
  for (const e of standalone) {
    const type = e.meta.domain === "projects" || e.meta.domain === "workflows" ? "topic" : "concept"
    const newPath = `${type === "topic" ? "topics" : "concepts"}/${e.meta.id}.md`
    structures.push({ plan: { oldId: e.meta.id, oldPath: e.relPath, newId: e.meta.id, newPath, action: type }, sources: [e], kind: "plain" })
    retired.push({ from: e.relPath, to: `_retired/v2/${e.relPath}` })
    for (const a of extractRuleAnchors(e.body)) {
      anchors.push({ ref: `${e.meta.id}#${a}`, anchor: a, oldPath: e.relPath, newPath, carried: type === "topic" })
    }
  }
  for (const item of groupPlans) {
    // 整组分片一律退役（一页一 retired 只在组级记一次）
    for (const e of item.ordered) retired.push({ from: e.relPath, to: `_retired/v2/${e.relPath}` })
    // 锚点台账（组级一遍）：按术语实际落页登记（重复术语行映射到其首落页）
    for (const e of item.ordered) {
      const { rules } = decomposeBody(e.body)
      for (const l of rules) {
        const term = stripAnchorComment(l)
        const owner = item.pages.find(pg => pg.terms.some(t => t.line === term && t.src === e))
          ?? item.pages.find(pg => pg.terms.some(t => t.line === term))
          ?? item.pages[0]
        for (const a of extractRuleAnchors(l)) {
          anchors.push({ ref: `${e.meta.id}#${a}`, anchor: a, oldPath: e.relPath, newPath: owner.newPath, carried: false })
        }
      }
    }
    for (const page of item.pages) {
      const firstContrib = page.contributors[0] ?? item.ordered[0]
      const mergedFrom = page.contributors.filter(c => c.meta.id !== page.newId).map(c => c.meta.id)
      structures.push({
        plan: {
          oldId: firstContrib.meta.id,
          oldPath: firstContrib.relPath,
          newId: page.newId,
          newPath: page.newPath,
          action: item.ordered.length > 1 || page.pageNum > 1 ? "merged-concept" : "concept",
          ...(mergedFrom.length > 0 ? { mergedFrom } : {}),
        },
        sources: page.contributors,
        kind: "glossary",
        glossaryRef: { item, page },
      })
    }
  }

  // ── pass 2：linkMap（先到先得）→ 终稿内容 ────────────────────────────
  const linkMap = buildLinkMap(structures.map(s => ({ plan: s.plan, sources: s.sources })))
  for (const s of structures) {
    let meta: WikiPageFrontmatter
    let body: string
    if (s.kind === "glossary" && s.glossaryRef) {
      const { item, page } = s.glossaryRef
      const built = glossaryPageContent(item.base, item.ordered, page, page.terms, page.others)
      meta = built.meta
      body = built.body
    } else {
      const base = s.sources[0]
      const type = s.plan.action === "topic" ? "topic" : "concept"
      meta = pageMetaFrom(base, type, s.sources)
      meta.id = s.plan.newId
      body = type === "topic" ? buildTopicBody(base.body) : buildConceptBody(base.body)
    }
    body = rewriteWikiLinks(body, linkMap)
    planned.push({ plan: s.plan, sources: s.sources, content: serializePageMarkdown(meta, body) })
  }

  planned.sort((a, b) => a.plan.newPath.localeCompare(b.plan.newPath))
  retired.sort((a, b) => a.from.localeCompare(b.from))
  return { planned, pages: planned.map(p => p.plan), anchors, retired }
}

/** 旧表格 LOG 数据行提取（六列 `| 日期 | … |`；表头/分隔行不算数据）。干跑预览与 apply 共用。 */
export function legacyLogTableRows(logText: string): Array<{ date: string; action: string; entry: string; summary: string; source: string; reviewer: string }> {
  const rows: Array<{ date: string; action: string; entry: string; summary: string; source: string; reviewer: string }> = []
  for (const line of logText.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\| (\d{4}-\d{2}-\d{2}) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line.trim())
    if (!m) continue
    rows.push({ date: m[1], action: m[2], entry: m[3], summary: m[4], source: m[5], reviewer: m[6] })
  }
  return rows
}

/** 表格 LOG → v3 行格式（prototype Tab② LOG 契约逐字；reviewer 单元格自带 ✓，原样承接）。 */
export function convertLegacyLog(logText: string): string {
  const rows = legacyLogTableRows(logText)
  return WIKI_LOG_HEADER + rows.map(r => `## [${r.date}] ${r.action} | ${r.entry}\n  → ${r.summary} · ${r.source} · ${r.reviewer}\n`).join("")
}

/** 批通道输入：计划即终稿——只做映射。 */
export function buildBatchInputs(plan: RedistillPlan): BatchPageInput[] {
  return plan.planned.map(p => ({ content: p.content, fileName: p.plan.newPath.split("/").pop() }))
}

export class WikiRedistillMigrator {
  private readonly apply: boolean
  private readonly root: string
  private readonly org: string
  private readonly db: Database.Database
  private readonly queue?: WriteQueue

  constructor(opts: RedistillOptions) {
    this.db = opts.db
    this.apply = opts.apply ?? false
    this.root = opts.wikiRoot ?? resolveGlobalWikiRoot()
    this.org = opts.org ?? GLOBAL_WIKI_ORG
    this.queue = opts.queue
  }

  get wikiRoot(): string {
    return this.root
  }

  async run(): Promise<RedistillReport> {
    const entries = readV2Entries(this.root)
    const plan = planMappings(entries, this.root)
    const logText = fs.existsSync(path.join(this.root, "LOG.md")) ? fs.readFileSync(path.join(this.root, "LOG.md"), "utf-8") : ""
    const beforeTotal = (this.db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org = ?").get(this.org) as { n: number }).n

    const report: RedistillReport = {
      dryRun: !this.apply,
      changed: false,
      pages: plan.pages,
      anchors: plan.anchors,
      retired: plan.retired,
      log: { tableRows: legacyLogTableRows(logText).length },
      db: { beforeTotal },
      commit: null,
      backupHint: this.backupHint(),
    }
    if (!this.apply) return report

    // 写段工作 = 重蒸馏执行（非空计划）或收敛补账（空计划：上次中断后重跑，幂等含 DB）
    const work = async (): Promise<void> => {
      if (plan.pages.length === 0) {
        report.reason = fs.existsSync(path.join(this.root, REDISTILL_MAP_REL)) ? "already-redistilled" : "no-v2-entries"
        const dbx = this.reconcileDb(plan)
        report.db = { ...report.db, ...dbx }
        report.changed = dbx.deleted.length > 0 || dbx.caseRowsRetyped > 0
        return
      }
      await this.execute(plan, report)
    }

    // 票06 写串行：注入全局队列 ⇒ kind "redistill" 入队 + wiki 根锁（spec §全局写串行
    // 「重蒸馏统一入队，禁旁路」）；ops 命令形态保持同步回报——入队后轮询至终态。
    if (!this.queue) {
      await work()
      return report
    }
    const view = this.queue.enqueue("redistill", work, { label: "redistill: v2→v3 迁移执行" })
    report.queueTaskId = view.id
    let latest = view
    for (let waitedMs = 0; ; ) {
      latest = this.queue.get(view.id) ?? latest
      if (latest.state === "committed" || latest.state === "failed") break
      if (waitedMs >= REDISTILL_QUEUE_WAIT_LIMIT_MS) {
        throw new Error(`REDISTILL_QUEUE_TIMEOUT: 任务 ${view.id} 在 ${REDISTILL_QUEUE_WAIT_LIMIT_MS / 1000}s 内未达终态（队列在跑别的写操作？稍后重查 GET /api/knowledge/wiki/queue/task/${view.id}）`)
      }
      await sleepMs(10)
      waitedMs += 10
    }
    if (latest.state === "failed") {
      const code = latest.error?.code ?? "QUEUE_OP_FAILED"
      throw new Error(`${code}: ${latest.error?.message ?? "写队列任务失败"}`)
    }
    return report
  }

  private async execute(plan: RedistillPlan, report: RedistillReport): Promise<void> {
    const mapAbs = path.join(this.root, REDISTILL_MAP_REL)
    const logAbs = path.join(this.root, "LOG.md")
    const prevLog = fs.existsSync(logAbs) ? fs.readFileSync(logAbs, "utf-8") : null
    const moved: Array<{ to: string; from: string }> = []
    let mapWritten = false

    try {
      // ── 闸外前置步 1：旧词条整迁 _retired/v2/（rename 同盘原子；不删除）──
      fs.mkdirSync(path.dirname(mapAbs), { recursive: true })
      for (const r of plan.retired) {
        const fromAbs = path.join(this.root, r.from)
        const toAbs = path.join(this.root, r.to)
        fs.mkdirSync(path.dirname(toAbs), { recursive: true })
        fs.renameSync(fromAbs, toAbs)
        moved.push({ to: toAbs, from: fromAbs })
      }
      // ── 闸外前置步 2：锚点随迁对照表落盘（git add -A 随闸单 commit 收编）──
      fs.writeFileSync(mapAbs, `${JSON.stringify({ version: 1, pages: plan.pages, anchors: plan.anchors }, null, 2)}\n`, "utf-8")
      mapWritten = true
      // ── 闸外前置步 3：LOG 旧表格 → 行格式（原表封 git 史；闸随后 append redistill 行）──
      const legacyRows = legacyLogTableRows(prevLog ?? "")
      if (legacyRows.length > 0) fs.writeFileSync(logAbs, convertLegacyLog(prevLog as string), "utf-8")

      // ── 唯一写闸：v3 页批通道（lint/L4/INDEX/LOG/DB/FTS + 单 commit）──
      const compiler = new WikiCompileService({ db: this.db, org: this.org, rootDir: this.root })
      const inputs = buildBatchInputs(plan)
      const carried = plan.anchors.filter(a => a.carried).length
      const res = await compiler.compilePages(inputs, {
        action: "compile",
        entry: `redistill: v2→v3（${plan.pages.length} 页）`,
        note: `${plan.planned.length} 映射·锚点原号随迁 ${carried}·剥落登记 ${plan.anchors.length - carried}·旧页迁 _retired/v2`,
        source: "redistill.migrate",
        reviewer: "curator",
      })

      // ── DB 对账段：merged 行删除 + 判例 type 值切 'case' + FTS 重建 + 行数守恒验证 ──
      const dbx = this.reconcileDb(plan)

      report.changed = res.changed || dbx.deleted.length > 0 || dbx.caseRowsRetyped > 0
      report.commit = res.commit
      report.db = { ...report.db, afterTotal: dbx.afterTotal, byType: dbx.byType, deleted: dbx.deleted }
    } catch (err) {
      // 闸自身快照回滚已完成；这里还原闸外三步——不留半成品（形制同 compile.ts rollbackTo 纪律）
      for (const m of moved) {
        try { fs.renameSync(m.to, m.from) } catch { /* best effort */ }
      }
      try {
        if (prevLog === null) fs.rmSync(logAbs, { force: true })
        else fs.writeFileSync(logAbs, prevLog, "utf-8")
      } catch { /* best effort */ }
      if (mapWritten) {
        try { fs.rmSync(mapAbs, { force: true }) } catch { /* best effort */ }
      }
      throw err
    }
  }

  /**
   * DB 对账（幂等收敛式：重复执行到同一终态）：
   * - 在盘活页行已由闸 upsert（domain=五类值）；
   * - 被归并分片行删除（去向记在 deleted，审计面不丢；台账在收敛段兜底）；
   * - 判例行 domain 值 'cases'→'case'（文件写面 domain:cases 不变——读写面在 DB 统一）；
   * - FTS 蓝绿重建（DDL 派生自现表，单源不复制 schema）；
   * - 行数对账：afterTotal 必须等于在盘活页扫描数，且 before 每行去向可解释，否则 VERIFY 抛。
   */
  private reconcileDb(plan: RedistillPlan): { afterTotal: number; byType: Record<string, number>; deleted: Array<{ id: string; mergedInto: string }>; caseRowsRetyped: number } {
    const live = scanWikiEntries(this.root)
    const liveIds = new Set(live.map(e => e.meta.id))
    const liveCases = new Set(live.filter(e => e.type === "case").map(e => e.meta.id))
    const beforeRows = this.db.prepare("SELECT id FROM wiki_articles WHERE org = ?").all(this.org) as Array<{ id: string }>
    const mergedOf = new Map<string, string>()
    const putFirst = (k: string, v: string): void => {
      if (!mergedOf.has(k)) mergedOf.set(k, v)
    }
    for (const p of plan.pages) for (const c of p.mergedFrom ?? []) putFirst(c, p.newId)
    if (mergedOf.size === 0) {
      // 收敛段（重跑/中断续跑）：计划已空，归并去向从对照表台账重建
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.root, REDISTILL_MAP_REL), "utf-8")) as { pages?: RedistillPagePlan[] }
        for (const p of j.pages ?? []) for (const c of p.mergedFrom ?? []) putFirst(c, p.newId)
      } catch { /* 无台账 ⇒ 无归并可解释 */ }
    }

    const deleted: Array<{ id: string; mergedInto: string }> = []
    let caseRowsRetyped = 0
    const dao = new WikiArticleDAO(this.db)
    this.db.transaction(() => {
      for (const row of beforeRows) {
        if (liveIds.has(row.id)) continue // 在盘活页行（闸已 upsert 五类值 / 判例在下一段换值）
        const mergedInto = mergedOf.get(row.id)
        // 对账纪律：既不在盘、台账也解释不了的去向 = 丢行，硬拒（不让"没数到"冒充"没丢"）
        if (!mergedInto) {
          throw new Error(`REDISTILL_DB_VERIFY_FAILED: 行 '${row.id}' 既非在盘活页也非判例，也无归并去向——拒绝继续`)
        }
        const rid = this.db.prepare("SELECT rowid AS rid FROM wiki_articles WHERE org = ? AND id = ?").get(this.org, row.id) as { rid: number } | undefined
        if (rid !== undefined) {
          try { dao.deleteFts(rid.rid) } catch { /* FTS 重建段兜底 */ }
        }
        this.db.prepare("DELETE FROM wiki_articles WHERE org = ? AND id = ?").run(this.org, row.id)
        deleted.push({ id: row.id, mergedInto })
      }
      // 判例 type 值切 'case'
      for (const id of liveCases) {
        const cur = this.db.prepare("SELECT domain FROM wiki_articles WHERE org = ? AND id = ?").get(this.org, id) as { domain: string } | undefined
        if (cur && cur.domain !== "case") {
          this.db.prepare("UPDATE wiki_articles SET domain = 'case' WHERE org = ? AND id = ?").run(this.org, id)
          caseRowsRetyped++
        }
      }
      // FTS 蓝绿重建：DDL 派生自现表（sqlite_master），列集取自 PRAGMA——不复制 schema 文本
      const ftsDdl = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_fts'").get() as { sql: string } | undefined
      if (ftsDdl) {
        const cols = (this.db.prepare("PRAGMA table_info(wiki_fts)").all() as Array<{ name: string }>).map(c => c.name)
        const newDdl = ftsDdl.sql.replace(/\bwiki_fts\b/, "wiki_fts_redistill")
        this.db.exec(newDdl)
        this.db.exec(`INSERT INTO wiki_fts_redistill (rowid, ${cols.join(", ")}) SELECT rowid, ${cols.join(", ")} FROM wiki_articles`)
        this.db.exec("DROP TABLE wiki_fts")
        this.db.exec("ALTER TABLE wiki_fts_redistill RENAME TO wiki_fts")
      }
    })()

    const afterTotal = (this.db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE org = ?").get(this.org) as { n: number }).n
    if (afterTotal !== live.length) {
      throw new Error(`REDISTILL_DB_VERIFY_FAILED: 行数对账不符（wiki_articles=${afterTotal}，在盘活页=${live.length}）`)
    }
    const byType = Object.fromEntries(
      (this.db.prepare("SELECT domain, COUNT(*) AS n FROM wiki_articles WHERE org = ? GROUP BY domain").all(this.org) as Array<{ domain: string; n: number }>)
        .map(r => [r.domain, r.n]),
    )
    return { afterTotal, byType, deleted, caseRowsRetyped }
  }

  private backupHint(): string {
    let dbFile = ""
    try {
      const list = this.db.pragma("database_list") as Array<{ file: string }>
      dbFile = list[0]?.file ?? ""
    } catch { /* 匿名库（内存）无路径 */ }
    const target = dbFile || "~/.octopus/db/octopus.db"
    return `写操作前必备份（主控执行）：sqlite3 "${target}" "VACUUM INTO '${target}.pre-redistill.bak'"（重蒸馏 fs 面 git revert 可还原，DB 面靠备份回滚）`
  }
}
