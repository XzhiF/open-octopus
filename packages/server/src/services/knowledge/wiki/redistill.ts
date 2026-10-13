import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import type { WikiEntryFrontmatter, WikiPageFrontmatter } from "@octopus/shared"
import { GLOBAL_WIKI_ORG, resolveGlobalWikiRoot } from "../global-paths"
import { parseWikiFile, extractRuleAnchors, serializePageMarkdown, RULE_ANCHOR_RE } from "./format"
import { REDISTILL_MAP_REL, WIKI_DOMAINS } from "./paths"
import { parseH2Sections, TOPIC_CONSTRAINTS_SECTION } from "./lint"
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
 *     {pkg}`）按 pkg 归并对应概念页（base chunk 保号，-N 分片并入 mergedFrom）
 *   - research 词条 → concepts 页（source 回执页是票05 raw 编译管线的产物，重蒸馏不伪造——
 *     偏离决策见票报告）
 *   - cases 原样保留（文件不动；DB type 值切 'case' 属 re-key 段）
 *   - 非 topic 页按 v3 锚点小节铁律（lint L5_ANCHOR_SCOPE）不落锚点注释：剥落的锚点
 *     原号进对照表台账（carried=false），永不复用由 nextRuleAnchor 读台账保证
 *   - 旧词条文件整迁 `_retired/v2/{domain}/`（不删除；hub 子目录形态出现即
 *     REDISTILL_UNSUPPORTED_HUB 硬拒交人工裁决）
 *   - [[链接]] 机械改写：指向 v2 旧路径/被并 chunk id 的目标改指新页（断链零）
 *   - LOG.md 旧表格行机械转换 `## [date] op | title → 结果` 行格式（原表封 git 史）
 *   - INDEX.md 程序化重建五类分组（写闸 compilePages 内 renderBudgetedWikiIndex 单源）
 *   - DB wiki_articles type 值切五类 + FTS 重建（蓝绿派生自现 DDL），行数对账不丢
 *   - 全部落盘 = 一个 git commit（整体 revert 可还原）；重跑 diff 为空（幂等）。
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
  /** 映射源的词条 id（merged 时 = base chunk id） */
  oldId: string
  /** v2 相对路径，如 workflows/wf-prd-impl.md */
  oldPath: string
  newId: string
  /** v3 相对路径，如 topics/wf-prd-impl.md */
  newPath: string
  action: RedistillAction
  /** merged-concept：被吸收的分片 id */
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
}

export interface RedistillOptions {
  db: Database.Database
  /** false（默认）= dry-run 只读列计划；true = 执行（写页/迁旧/LOG/INDEX/DB/commit） */
  apply?: boolean
  /** 全局 wiki 根覆盖（缺省 resolveGlobalWikiRoot()；测试注入 tmpdir fixture） */
  wikiRoot?: string
  /** DB org 钉值（缺省 'global'，票03 re-key 后语义） */
  org?: string
}

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

/** 计划条目 = 映射计划 + 全部源词条（apply 构造正文时按 sources 顺序合成）。 */
export interface PlannedPage {
  plan: RedistillPagePlan
  /** topic/concept 一页一源；merged-concept 按 base→-2→-3 升序 */
  sources: V2Entry[]
}

export interface RedistillPlan {
  planned: PlannedPage[]
  pages: RedistillPagePlan[]
  anchors: RedistillAnchorEntry[]
  retired: Array<{ from: string; to: string }>
}

/** 映射计划（纯函数，dry-run 与 apply 共用同一份——计划即真相）。 */
export function planMappings(entries: V2Entry[]): RedistillPlan {
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

  const pushAnchors = (e: V2Entry, newPath: string, carried: boolean): void => {
    for (const a of extractRuleAnchors(e.body)) {
      anchors.push({ ref: `${e.meta.id}#${a}`, anchor: a, oldPath: e.relPath, newPath, carried })
    }
  }

  for (const e of standalone) {
    const type = e.meta.domain === "projects" || e.meta.domain === "workflows" ? "topic" : "concept"
    const newPath = `${type === "topic" ? "topics" : "concepts"}/${e.meta.id}.md`
    planned.push({ plan: { oldId: e.meta.id, oldPath: e.relPath, newId: e.meta.id, newPath, action: type }, sources: [e] })
    retired.push({ from: e.relPath, to: `_retired/v2/${e.relPath}` })
    pushAnchors(e, newPath, type === "topic")
  }

  for (const [pkg, g] of [...groups.entries()].sort()) {
    const ordered = [...g].sort((a, b) => chunkIndex(a.meta.id, pkg) - chunkIndex(b.meta.id, pkg) || a.meta.id.localeCompare(b.meta.id))
    const base = ordered.find(e => chunkIndex(e.meta.id, pkg) === 0) ?? ordered[0]
    const newId = chunkIndex(base.meta.id, pkg) === 0 ? base.meta.id : `biz-glossary-${pkg}`
    const newPath = `concepts/${newId}.md`
    const mergedFrom = ordered.filter(e => e.meta.id !== newId).map(e => e.meta.id)
    planned.push({
      plan: {
        oldId: base.meta.id,
        oldPath: base.relPath,
        newId,
        newPath,
        action: ordered.length > 1 ? "merged-concept" : "concept",
        ...(mergedFrom.length > 0 ? { mergedFrom } : {}),
      },
      sources: ordered,
    })
    for (const e of ordered) {
      retired.push({ from: e.relPath, to: `_retired/v2/${e.relPath}` })
      pushAnchors(e, newPath, false)
    }
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

/** 归并 Glossary 分片 → 单页概念正文：`## 术语` 汇集全部术语行（剥锚、去重），其余行入 `## 说明`。 */
export function buildMergedGlossaryBody(sources: V2Entry[]): string {
  const termLines: string[] = []
  const seen = new Set<string>()
  const other: string[] = []
  for (const e of sources) {
    const { preamble, sections, rules } = decomposeBody(e.body)
    for (const l of rules) {
      const t = stripAnchorComment(l)
      if (!seen.has(t)) {
        seen.add(t)
        termLines.push(t)
      }
    }
    for (const l of preamble) if (!other.includes(l)) other.push(l)
    for (const s of sections) for (const l of s.lines) if (!other.includes(l)) other.push(l)
  }
  const blocks = [other.length > 0 ? `## 说明\n${other.join("\n")}` : "", `## 术语\n${termLines.join("\n")}`]
  return assemble(blocks)
}

/**
 * [[链接]] 机械改写表：v2 旧路径/旧 id → 新路径/新 id。
 * 值形态跟随键形态：路径式目标 → 新路径（无 .md，resolveWikiLink 补），裸 id 目标 → 新 id。
 */
function buildLinkMap(plan: RedistillPlan): Map<string, string> {
  const map = new Map<string, string>()
  const put = (oldKey: string, newKey: string): void => {
    map.set(oldKey, newKey)
    map.set(`${oldKey}.md`, `${newKey}.md`)
  }
  for (const { plan: p, sources } of plan.planned) {
    const newNoMd = p.newPath.replace(/\.md$/, "")
    put(p.oldPath.replace(/\.md$/, ""), newNoMd)
    map.set(p.oldId, p.newId)
    for (const src of sources) {
      if (src.meta.id === p.newId) continue
      // 归并分片：chunk id 与 chunk 旧路径都改指并入页
      put(src.relPath.replace(/\.md$/, ""), newNoMd)
      map.set(src.meta.id, p.newId)
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
function pageMetaFrom(e: V2Entry, type: "topic" | "concept", sources: V2Entry[]): WikiPageFrontmatter {
  const union = (pick: (m: WikiEntryFrontmatter) => string[]): string[] => {
    const out: string[] = []
    for (const s of sources) for (const v of pick(s.meta)) if (!out.includes(v)) out.push(v)
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

/** 构造批通道输入（每计划页一条 content——serializePageMarkdown 单源序列化）。 */
export function buildBatchInputs(plan: RedistillPlan): BatchPageInput[] {
  const linkMap = buildLinkMap(plan)
  return plan.planned.map(({ plan: p, sources }) => {
    const base = sources[0]
    let meta: WikiPageFrontmatter
    let body: string
    if (p.action === "topic") {
      meta = pageMetaFrom(base, "topic", sources)
      meta.id = p.newId
      body = buildTopicBody(base.body)
    } else if (p.action === "merged-concept") {
      meta = pageMetaFrom(base, "concept", sources)
      meta.id = p.newId
      body = buildMergedGlossaryBody(sources)
    } else {
      meta = pageMetaFrom(base, "concept", sources)
      meta.id = p.newId
      body = buildConceptBody(base.body)
    }
    body = rewriteWikiLinks(body, linkMap)
    return { content: serializePageMarkdown(meta, body), fileName: p.newPath.split("/").pop() }
  })
}

export class WikiRedistillMigrator {
  private readonly apply: boolean
  private readonly root: string
  private readonly org: string
  private readonly db: Database.Database

  constructor(opts: RedistillOptions) {
    this.db = opts.db
    this.apply = opts.apply ?? false
    this.root = opts.wikiRoot ?? resolveGlobalWikiRoot()
    this.org = opts.org ?? GLOBAL_WIKI_ORG
  }

  get wikiRoot(): string {
    return this.root
  }

  async run(): Promise<RedistillReport> {
    const entries = readV2Entries(this.root)
    const plan = planMappings(entries)
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
    if (plan.pages.length === 0) {
      report.reason = fs.existsSync(path.join(this.root, REDISTILL_MAP_REL)) ? "already-redistilled" : "no-v2-entries"
      // 收敛段：上次 apply 若在闸 commit 后 DB 对账前中断，重跑补成一致态（幂等含 DB）
      const dbx = this.reconcileDb(plan)
      report.db = { ...report.db, ...dbx }
      report.changed = dbx.deleted.length > 0 || dbx.caseRowsRetyped > 0
      return report
    }
    return this.execute(plan, report)
  }

  private async execute(plan: RedistillPlan, report: RedistillReport): Promise<RedistillReport> {
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
      return report
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
   * - 计划新 id 行已由闸 upsert（domain=五类值）；
   * - 被归并分片行删除（去向记在 deleted，审计面不丢）；
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
    for (const p of plan.pages) for (const c of p.mergedFrom ?? []) mergedOf.set(c, p.newId)
    if (mergedOf.size === 0) {
      // 收敛段（重跑/中断续跑）：计划已空，归并去向从对照表台账重建
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.root, REDISTILL_MAP_REL), "utf-8")) as { pages?: RedistillPagePlan[] }
        for (const p of j.pages ?? []) for (const c of p.mergedFrom ?? []) mergedOf.set(c, p.newId)
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
