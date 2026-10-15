import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { WikiCaseFrontmatter, WikiPageType } from "@octopus/shared"
import { STALE_REF_PREFIX, WIKI_REFS_KEY } from "@octopus/shared"
import { applySchema } from "../../db/schema"
import type { FindingUpsert } from "../../db/dao/findings-dao"
import { FindingsDAO } from "../../db/dao/findings-dao"
import { scanWikiEntries } from "./wiki/compile"
import { parseWikiFile } from "./wiki/format"
import { resolveWikiLink, WIKILINK_RE } from "./wiki/lint"
import { resolveKnowledgeRoot } from "./global-paths"

/**
 * WikiPatrolService — 语义巡检「库自己会体检」（知识中心票13 主控，spec 质控⑤；
 * P3 票03 五查扩六查）。
 *
 * 六查（票面 AC1，全部**确定性**遍历，不经 LLM——内容寻址 id 要求证据可复算，
 * LLM 自由发挥会让 finding id 每晚漂移、幂等破产）：
 *  ① 页间矛盾（断言对立）：扫盘上「## 冲突待裁决」标记行（票05 编译通道的持久证据面），
 *     findings 行缺席时复报（DB 只是索引、fs+git 是真源——findings 被清/搬家后巡检兜底
 *     重建报料；复用标记内 fnd- id ⇒ 与编译通道天然同址、零双报）。
 *  ② stale 断言：消费侧信号闭环（故事 29）——executions.var_pool 的 wiki_refs 里
 *     `stale:<ref> <note>` 行转 finding（octo-wiki 引用纪律的形态；STALE_REF_PREFIX 单源）。
 *  ③ 孤儿页（零入链）：内容页（entity/concept/topic/case）不被任何**其它内容页**
 *     （front-matter links ∪ 正文 [[链接]]）引用。sources 回执页不算入链方——
 *     否则每个编译页都被自己的回执页"挂住"，孤儿判据死码。
 *  ④ 被提及但缺页的概念：[[链接]]/front-matter links 目标解析失败（resolveWikiLink
 *     与编译期 L5 断链闸同一判据——单源）。
 *  ⑤ 缺失交叉引用：同类页（同 type 的内容页）共享 topic 标签却互不链接，给建议对。
 *  ⑥ 判例积压（P3 票03，spec 故事 13）：open 且 occurrences≥2 且无 rule_ref 的判例 ⇒
 *     finding 提议蒸馏为 topics 硬约束（判例是规则的原料；裁决面=finding adopt 通道，
 *     产物互指：topic 页 [[case]] + case.rule_ref=锚点、status=distilled）。
 *
 * 裁决三态纪律（票面 AC2/AC5）：已有行 status ∈ {resolved, ignored} ⇒ 本巡检**永不再扰**
 * （不写库、报告记 suppressed）；open 行证据变化 ⇒ 刷新（upsert 保人裁决的 DAO 契约）、
 * 不变 ⇒ 零写。幂等：重跑同库 = 同 id 集、零新行。
 *
 * 副作用面：只写 findings 表；wiki/fs/git 零触碰（夜巡不起写队列）。读永不锁（票06 语义）。
 */

/**
 * P4 票03 扩枚举：`index-budget`（INDEX 恒见预算预警）——生产者=编译通道（compile.ts
 * l4BudgetGate 直 upsert，本巡检六查不产该 kind），入本联合是为 UI/卡片按值消费的
 * kind 词表单源（红线2：预警=finding 事后人裁，采纳走 finding-fix 队列重编译 INDEX）。
 */
export type PatrolFindingKind = "contradiction" | "stale" | "orphan" | "missing-page" | "missing-xref" | "case-backlog" | "index-budget"

/** 单条巡检动作：created=新建 · refreshed=open 行证据刷新 · unchanged=零写 · suppressed=已裁决不再扰 */
export type PatrolAction = "created" | "refreshed" | "unchanged" | "suppressed"

export interface PatrolFindingEntry {
  id: string
  kind: PatrolFindingKind
  title: string
  pages: string[]
  action: PatrolAction
  /** ④ 缺页目标裸串（UI finding 卡定位用；其它 kind 缺省） */
  target?: string
  /** ⑤ 建议对 / ④ 引用宿主（页相对路径） */
  hosts?: string[]
}

/**
 * 巡检草案 = findings upsert 行 + kind 收窄 + UI 附加位（target/hosts 不入库，随报告走）。
 * recoveryOnly（矛盾复报面）：行已存在就**绝不改写**——编译通道(detail.raw)与人工裁决
 * 的证据面只属于先落笔者；巡检只在证据消失（DB 被清）时兜底重建。
 */
type PatrolDraft = FindingUpsert & {
  kind: PatrolFindingKind
  target?: string
  hosts?: string[]
  recoveryOnly?: boolean
}
export interface PatrolReport {
  scanned: { pages: number; executions: number }
  findings: PatrolFindingEntry[]
  counts: Partial<Record<PatrolFindingKind, number>>
  /** 本轮新建的行（夜巡 Lane A 报对话只报增量，不刷存量） */
  newFindings: FindingUpsert[]
  warnings: string[]
}

export interface PatrolDeps {
  db: Database.Database
  /** 知识根覆盖（测试注入 tmpdir；缺省 resolveKnowledgeRoot()） */
  root?: string
  now?: () => Date
}

const CONTENT_TYPES: ReadonlySet<WikiPageType> = new Set(["entity", "concept", "topic", "case"])

function sha16(key: string): string {
  return `fnd-${crypto.createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 16)}`
}

/** 页磁盘视图：relPath + 解析出的 front-matter/正文（坏页跳过并留 warning，不拖垮整巡）。 */
interface PageView {
  relPath: string
  id: string
  type: WikiPageType
  topics: string[]
  /** front-matter links（裸串）∪ 正文 [[链接]]（裸目标，去重） */
  outTargets: string[]
  body: string
  sources: string[]
  /** 正文规则锚点（stale 上报按锚归属页） */
  anchors: string[]
  /** P3 票03 六查：判例文件的 front-matter（非判例=undefined；scanWikiEntries 已解析） */
  case?: WikiCaseFrontmatter
}

export class WikiPatrolService {
  readonly root: string
  readonly wikiRoot: string
  private readonly db: Database.Database
  private readonly now: () => Date

  constructor(deps: PatrolDeps) {
    this.db = deps.db
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.now = deps.now ?? (() => new Date())
  }

  patrol(): PatrolReport {
    applySchema(this.db) // findings 表幂等保底（同服务先例：建表在 schema，运行期只增量确保）
    const warnings: string[] = []
    const pages = this.loadPages(warnings)
    const drafts = this.collectDrafts(pages, warnings)

    const dao = new FindingsDAO(this.db)
    const findings: PatrolFindingEntry[] = []
    const newFindings: FindingUpsert[] = []
    for (const d of drafts) {
      const existing = dao.getById(d.id)
      let action: PatrolAction
      if (!existing) {
        dao.upsert(d)
        action = "created"
        newFindings.push(d)
      } else if (existing.status === "resolved" || existing.status === "ignored") {
        action = "suppressed" // 已裁决（人或巡检通道外）⇒ 永不再扰
      } else if (d.recoveryOnly || sameEvidence(existing, d)) {
        action = "unchanged" // recoveryOnly 面：既有 open 行属于别的落笔者，巡检不动它
      } else {
        dao.upsert(d) // open 行：刷新证据（status 不动——DAO upsert 契约）
        action = "refreshed"
      }
      findings.push({
        id: d.id,
        kind: d.kind,
        title: d.title,
        pages: JSON.parse(d.pages) as string[],
        action,
        ...(d.target !== undefined ? { target: d.target } : {}),
        ...(d.hosts !== undefined ? { hosts: d.hosts } : {}),
      })
    }

    const counts: Partial<Record<PatrolFindingKind, number>> = {}
    for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1
    const execScanned = this.countExecutions()
    return { scanned: { pages: pages.length, executions: execScanned }, findings, counts, newFindings, warnings }
  }

  /** 真 fs 读库：scanWikiEntries 给目录清单与分型，正文/链接再从盘解析（fs=真源纪律）。 */
  private loadPages(warnings: string[]): PageView[] {
    const out: PageView[] = []
    for (const e of scanWikiEntries(this.wikiRoot)) {
      if (e.relPath.startsWith("_retired/")) continue // 退役区不参与体检
      let parsed: ReturnType<typeof parseWikiFile>
      try {
        parsed = parseWikiFile(fs.readFileSync(path.join(this.wikiRoot, e.relPath), "utf-8"))
      } catch (err) {
        warnings.push(`页解析跳过 ${e.relPath}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const body = parsed.body
      const links = parsed.kind === "page" ? parsed.meta.links : []
      const targets = new Set<string>(links)
      for (const m of body.matchAll(WIKILINK_RE)) targets.add(m[1]!.trim())
      out.push({
        relPath: e.relPath,
        id: e.meta.id,
        type: e.type,
        topics: e.meta.topics ?? [],
        outTargets: [...targets],
        body,
        sources: parsed.kind === "page" ? parsed.meta.sources : e.meta.sources ?? [],
        anchors: e.anchors,
        ...(parsed.kind === "case" ? { case: parsed.meta } : {}),
      })
    }
    return out
  }

  private countExecutions(): number {
    try {
      const r = this.db
        .prepare("SELECT COUNT(*) AS n FROM executions WHERE var_pool LIKE '%wiki_refs%'")
        .get() as { n: number }
      return r.n
    } catch {
      return 0 // 无 executions 表的裸库（单测最小面）⇒ 诚实零
    }
  }

  private collectDrafts(pages: PageView[], warnings: string[]): PatrolDraft[] {
    return [
      ...this.contradictionDrafts(pages),
      ...this.missingPageDrafts(pages, warnings),
      ...this.orphanDrafts(pages),
      ...this.missingXrefDrafts(pages),
      ...this.staleDrafts(pages, warnings),
      ...this.caseBacklogDrafts(pages),
    ]
  }

  /**
   * ⑥ 判例积压（P3 票03，spec 故事 13「判例是规则的原料」闭合面）：判例 front-matter
   * status=open ∧ occurrences≥2 ∧ 无 rule_ref ⇒ case-backlog finding，提议蒸馏进
   * topics 硬约束。判据全走 front-matter 计数面（正文零参与=确定性）；
   * 蒸馏动作本身复用 finding adopt 通道（findings.ts case-backlog 分支），产物互指。
   * occurrences 增长 ⇒ 证据变化刷新（distilled/superseded 即出列，永不再扰由三态兜）。
   */
  private caseBacklogDrafts(pages: PageView[]): PatrolDraft[] {
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const c = p.case
      if (!c) continue
      if (c.status !== "open" || c.occurrences < 2 || c.rule_ref !== undefined) continue
      drafts.push({
        id: sha16(`case-backlog|patrol|${p.relPath}`),
        kind: "case-backlog",
        title: `判例积压：${p.relPath}（症状「${c.symptom}」已 ${c.occurrences} 次命中，未蒸馏——提议编成 topics 硬约束）`,
        detail: JSON.stringify({ case: p.relPath, caseId: c.id, symptom: c.symptom, occurrences: c.occurrences, source: c.source }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ① 页间矛盾（断言对立）：票05 编译通道在两页写「## 冲突待裁决」标记行并落 findings；
   * fs 标记是证据真源、DB 是索引——索引缺席时按标记**复报**（复用标记内 fnd- id：
   * 编译通道本就是内容寻址，同 id ⇒ 天然与编译侧对址、零双报）。
   * 标记行模板解析 = curator.ts 写入格式（id 正则与其 appendContradictionMarker 同源）。
   */
  private contradictionDrafts(pages: PageView[]): PatrolDraft[] {
    const resolve = this.buildResolver(pages)
    const byId = new Map<string, { pages: Set<string>; oldClaim: string; newClaim: string }>()
    for (const p of pages) {
      for (const m of p.body.matchAll(/^>\s*【(fnd-[^\]】]+)】(.*)$/gm)) {
        const fid = m[1]!
        const text = m[2] ?? ""
        const claims = /旧断言「([^」]*)」↔[^「]*「([^」]*)」/.exec(text)
        const rec = byId.get(fid) ?? { pages: new Set<string>(), oldClaim: "", newClaim: "" }
        rec.pages.add(p.relPath)
        if (claims) {
          if (rec.oldClaim === "") rec.oldClaim = claims[1]!
          if (rec.newClaim === "") rec.newClaim = claims[2]!
        }
        const counterpart = /与\s*(?:\[\[([^\]]+)\]\]|旧页\s*(\S+?)(?:（|\s|，|。|$))/.exec(text)
        const token = (counterpart?.[1] ?? counterpart?.[2] ?? "").trim().replace(/\.md$/, "")
        const target = token ? resolve(token) : undefined
        if (target) rec.pages.add(target.relPath)
        byId.set(fid, rec)
      }
    }
    const drafts: PatrolDraft[] = []
    for (const [fid, rec] of [...byId.entries()].sort()) {
      const pageList = [...rec.pages].sort()
      drafts.push({
        id: fid,
        kind: "contradiction",
        recoveryOnly: true,
        title: `矛盾：${pageList.join(" ↔ ")}（页内标记复报）`,
        detail: JSON.stringify({ old_claim: rec.oldClaim, new_claim: rec.newClaim, pages: pageList, marker: "冲突待裁决复报" }),
        pages: JSON.stringify(pageList),
        raw_ref: pageList[0] ?? "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ② stale 断言（消费侧信号，故事 29）：executions.var_pool.wiki_refs 里的
   * `stale:<ref> <note>` 行（octo-wiki 引用纪律形态，STALE_REF_PREFIX 单源）→ finding。
   * ref 三形态：`页id#锚点` / `oct-NNN`（全库锚点归属）/ `页id 或路径`。
   * 窄口纪律：只吃 stale 前缀——正常查阅记录（wiki_refs 非 stale 项）不产 finding
   * 更不落 raw（执行侧产出永不自动回填；回填只走知识中心对话显式通道）。
   */
  private staleDrafts(pages: PageView[], warnings: string[]): PatrolDraft[] {
    const resolve = this.buildResolver(pages)
    const byAnchor = new Map<string, PageView>()
    for (const p of pages) for (const a of p.anchors) if (!byAnchor.has(a)) byAnchor.set(a, p)

    let rows: Array<{ id: string; var_pool: string | null }>
    try {
      rows = this.db
        .prepare("SELECT id, var_pool FROM executions WHERE var_pool LIKE ? ORDER BY id")
        .all(`%"${WIKI_REFS_KEY}"%`) as Array<{ id: string; var_pool: string | null }>
    } catch {
      return [] // 裸库无 executions 表 ⇒ stale 面诚实空
    }

    interface Report { pageRel: string; anchor: string; target: string; note: string; executionIds: string[] }
    const byKey = new Map<string, Report>()
    for (const row of rows) {
      let pool: Record<string, unknown>
      try {
        pool = JSON.parse(row.var_pool ?? "{}") as Record<string, unknown>
      } catch {
        continue
      }
      const refs = Array.isArray(pool[WIKI_REFS_KEY]) ? (pool[WIKI_REFS_KEY] as unknown[]).filter((x): x is string => typeof x === "string") : []
      for (const entry of refs) {
        if (!entry.startsWith(STALE_REF_PREFIX)) continue
        const rest = entry.slice(STALE_REF_PREFIX.length).trim()
        const [target = "", ...noteParts] = rest.split(/\s+/)
        const note = noteParts.join(" ")
        if (target === "") continue
        const hashAt = target.indexOf("#")
        const refPage = hashAt === -1 ? target : target.slice(0, hashAt)
        const refAnchor = hashAt === -1 ? undefined : target.slice(hashAt + 1)
        // 归属：`页ref#锚` 按页 ref；裸 token 先按页（id/路径/尾段）再按锚点全库归属
        const page = refAnchor !== undefined ? resolve(refPage) : (resolve(target) ?? byAnchor.get(target))
        if (!page) {
          warnings.push(`stale 上报目标不可解析，跳过：${target}（执行 ${row.id}）`)
          continue
        }
        const anchor = refAnchor ?? (refAnchor === undefined && byAnchor.has(target) ? target : "")
        const key = `${page.relPath}|${anchor}`
        const rec = byKey.get(key) ?? { pageRel: page.relPath, anchor, target, note: "", executionIds: [] }
        if (!rec.executionIds.includes(row.id)) rec.executionIds.push(row.id)
        if (note !== "" && !rec.note.includes(note)) rec.note = rec.note === "" ? note : `${rec.note}；${note}`
        byKey.set(key, rec)
      }
    }

    const drafts: PatrolDraft[] = []
    for (const [, r] of [...byKey.entries()].sort()) {
      drafts.push({
        id: sha16(`stale|patrol|${r.pageRel}|${r.anchor}`),
        kind: "stale",
        title: `stale 上报：${r.pageRel}${r.anchor ? `#${r.anchor}` : ""}（${r.executionIds.length} 次执行反馈）`,
        detail: JSON.stringify({ target: r.target, anchor: r.anchor || null, page: r.pageRel, note: r.note, executions: r.executionIds }),
        pages: JSON.stringify([r.pageRel]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * link 目标裸串 → 页（判定入链用）。解析键与 L5 同族（id/相对路径/去 .md/尾段名），
   * 但需要"落到哪一页"而非仅存在性——resolveWikiLink 不返回目标，这里自建映射。
   */
  private buildResolver(pages: PageView[]): (target: string) => PageView | undefined {
    const byKey = new Map<string, PageView>()
    for (const p of pages) {
      const stem = p.relPath.replace(/\.md$/, "")
      const base = p.relPath.split("/").pop() ?? p.relPath
      const baseStem = base.replace(/\.md$/, "")
      for (const k of [p.id, p.relPath, stem, base, baseStem]) {
        if (!byKey.has(k)) byKey.set(k, p)
      }
    }
    return (target: string) => {
      const t = target.trim().replace(/\/+$/, "").replace(/\.md$/, "")
      const base = t.split("/").pop() ?? t
      return byKey.get(t) ?? byKey.get(base)
    }
  }

  /**
   * ③ 孤儿页：内容页零入链（入链方 = 其它内容页；sources 回执页是编译回声，不算编织）。
   * P3 票03 蒸馏产物豁免：判例↔规则互指的另一腿——case.rule_ref 指向的锚点宿主页
   * 视为有入链（front-matter 指针边 = [[链接]] 边的等价形态；否则每次蒸馏必产
   * 「topic 孤儿」假阳性，六查闭环变两查噪音）。
   */
  private orphanDrafts(pages: PageView[]): PatrolDraft[] {
    const resolve = this.buildResolver(pages)
    const inbound = new Set<string>()
    for (const linker of pages) {
      if (!CONTENT_TYPES.has(linker.type)) continue
      for (const t of linker.outTargets) {
        const target = resolve(t)
        if (target && target.relPath !== linker.relPath) inbound.add(target.relPath)
      }
    }
    // rule_ref 边：判例（open/distilled 皆算，退役不解除引用关系）→ 锚点宿主页
    const anchorOwners = new Map<string, string>()
    for (const p of pages) for (const a of p.anchors) if (!anchorOwners.has(a)) anchorOwners.set(a, p.relPath)
    for (const p of pages) {
      const ref = p.case?.rule_ref
      if (!ref) continue
      const owner = anchorOwners.get(ref)
      if (owner && owner !== p.relPath) inbound.add(owner)
    }
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      if (!CONTENT_TYPES.has(p.type)) continue
      if (inbound.has(p.relPath)) continue
      drafts.push({
        id: sha16(`orphan|patrol|${p.relPath}`),
        kind: "orphan",
        title: `孤儿页：${p.relPath} 零入链（不被任何内容页引用）`,
        detail: JSON.stringify({ page: p.relPath }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ⑤ 缺失交叉引用：同类页（entity/concept/topic 同 type）共享 ≥1 topic 标签却互不
   * 链接（任一方向），给建议对。判例（case）走 tags 语义不在此面；sources 回执不参与。
   */
  private missingXrefDrafts(pages: PageView[]): PatrolDraft[] {
    const resolve = this.buildResolver(pages)
    const linkSet = new Set<string>()
    for (const p of pages) {
      if (!CONTENT_TYPES.has(p.type)) continue
      for (const t of p.outTargets) {
        const target = resolve(t)
        if (target) linkSet.add(`${p.relPath}→${target.relPath}`)
      }
    }
    const candidates = [...pages]
      .filter(p => p.type === "entity" || p.type === "concept" || p.type === "topic")
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
    const drafts: PatrolDraft[] = []
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!
        const b = candidates[j]!
        if (a.type !== b.type) continue
        const shared = a.topics.filter(t => b.topics.includes(t))
        if (shared.length === 0) continue
        if (linkSet.has(`${a.relPath}→${b.relPath}`) || linkSet.has(`${b.relPath}→${a.relPath}`)) continue
        const sorted = [a.relPath, b.relPath].sort()
        drafts.push({
          id: sha16(`missing-xref|patrol|${sorted[0]}|${sorted[1]}`),
          kind: "missing-xref",
          title: `缺互链：${sorted[0]} ↔ ${sorted[1]} 同 topic（${shared.join("/")}）建议交叉引用`,
          detail: JSON.stringify({ a: sorted[0], b: sorted[1], shared_topics: shared.sort() }),
          pages: JSON.stringify(sorted),
          raw_ref: "",
          source: "patrol",
        })
      }
    }
    return drafts
  }

  /** ④ 被提及但缺页：目标解析走 L5 断链闸同款 resolveWikiLink（单源判据）。 */
  private missingPageDrafts(pages: PageView[], warnings: string[]): PatrolDraft[] {
    const corpus = pages.map(p => ({ id: p.id, path: p.relPath }))
    const hostsByTarget = new Map<string, string[]>()
    for (const p of pages) {
      for (const t of p.outTargets) {
        if (resolveWikiLink(t, this.wikiRoot, corpus)) continue
        const list = hostsByTarget.get(t) ?? []
        if (!list.includes(p.relPath)) list.push(p.relPath)
        hostsByTarget.set(t, list)
      }
    }
    const drafts: PatrolDraft[] = []
    for (const [target, hosts] of [...hostsByTarget.entries()].sort()) {
      drafts.push({
        id: sha16(`missing-page|patrol|${target}`),
        kind: "missing-page",
        title: `缺页：[[${target}]] 被 ${hosts.length} 页引用但无实体页`,
        detail: JSON.stringify({ target, hosts }),
        pages: JSON.stringify(hosts),
        raw_ref: "",
        source: "patrol",
        target,
        hosts,
      })
    }
    void warnings
    return drafts
  }
}

/** 证据比对：title/detail/pages/raw_ref 四字段全同 ⇒ 零写（source 恒 patrol 不比）。 */
function sameEvidence(existing: { title: string; detail: string; pages: string; raw_ref: string }, d: FindingUpsert): boolean {
  return existing.title === d.title && existing.detail === d.detail && existing.pages === d.pages && existing.raw_ref === d.raw_ref
}
