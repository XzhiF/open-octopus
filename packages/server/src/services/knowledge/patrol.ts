import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import type { WikiCaseFrontmatter, WikiPageFrontmatter, WikiPageType } from "@octopus/shared"
import { STALE_REF_PREFIX, WIKI_REFS_KEY } from "@octopus/shared"
import { applySchema } from "../../db/schema"
import type { FindingUpsert } from "../../db/dao/findings-dao"
import { FindingsDAO } from "../../db/dao/findings-dao"
import { KnowledgeEffectivenessDAO } from "../../db/dao/knowledge-effectiveness-dao"
import { isLowConfidence, rollupConfidence, rollupEffectiveness } from "./effectiveness-confidence"
import { scanWikiEntries } from "./wiki/compile"
import { parseWikiFile, serializePageMarkdown } from "./wiki/format"
import { estimateTokens, resolveWikiLink, WIKILINK_RE, WIKI_LIMITS } from "./wiki/lint"
import { resolveKnowledgeRoot } from "./global-paths"

/**
 * WikiPatrolService — 语义巡检「库自己会体检」（知识中心票13 主控，spec 质控⑤；
 * P3 票03 五查扩六查）。
 *
 * 七查（票13 五查 + P3 票03 判例积压 = 六查；P4 票07 低置信扩第七查。全部**确定性**
 * 遍历，不经 LLM——内容寻址 id 要求证据可复算，
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
 *  ⑦ 低置信（P4 票07，spec 故事 5）：实效账目（knowledge_effectiveness 页键行∪锚点行）
 *     confidence≤0.2 且引用≥3 的 v3 页 ⇒ finding 提议修订或退役（确定性 DB 读零 LLM；
 *     裁决面=既有 finding 卡三态，红线2 零自动执行）。
 *     （P4 票03 另产 index-budget kind 由编译通道直产、不经本巡，见枚举注。）
 * P4 票08 数值查（spec 故事 9/11/12/13，原蓝图 D1/D3/D5/D7——本切片四个确定性同步查）：
 *  ⑧ 膨胀榜（D1，故事 9）：L1 容量闸（120 行/25 规则/2000 token 三阈值先到口径）水位
 *     ≥80% 的 v3 页 ⇒ bloat finding 预拆分提案——**不等触顶硬拒**，增长有提前量。
 *     判例豁免同 L1 闸律（lintProfileForPageType：判例天然长）。
 *  ⑨ 僵尸（D3，故事 11）：90 天零引用 ⇒ zombie finding 提议退役。**吃票06 账**
 *     （cited_count/last_cited 页级∪锚点级 rollup，单源纪律：不再自扫 JSONL）。
 *     dormant=有账但最近引用逾 90 天；never=无账且建页（last_compiled）逾 90 天。
 *     时钟经 PatrolDeps.now 注入（红线6：判据不 sleep、测试可钉表）。
 *  ⑩ 域失衡（D5，故事 12）：单页锚点数占全库在册锚点 >30% ⇒ domain-skew hub 化/拆分
 *     finding。全库锚点 <10 不判（小库份额无统计意义，防构造期假阳性）。
 *  ⑪ volatile 到期（D7，故事 13）：stability=volatile 页 review_after 已过 ⇒
 *     volatile-expired 复审 finding（续期/改写/退役三选一=**人裁侧**，E2 §8 实锤
 *     此判据零在跑实现——纯新建）。
 *  （D2 duplicate 含策展合并稿 LLM seam，见下——数值查与语义查同族纪律：判据确定性、
 *   id 内容寻址可复算；seam 只装饰附稿，坏形/缺席=诚实空稿不毁 finding 产出。）
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
 * P4 票07 扩枚举：`low-confidence`（实效账目低置信）——生产者=本巡检第七查
 * （lowConfidenceDrafts，DB knowledge_effectiveness 账目确定性读，零 LLM）；
 * 提议修订或退役全走既有 finding 卡三态人裁（红线2 零自动执行；窄口自动退役只属票09 一条）。
 * P4 票08 扩枚举：`bloat`（膨胀榜）/ `zombie`（僵尸）/ `domain-skew`（域失衡）/
 * `volatile-expired`（volatile 到期）——生产者=本巡检数值查（判据全部确定性：
 * L1 闸水位读盘、僵尸吃票06 账、失衡数锚点、到期读 front-matter）；处方出口一律
 * finding 人裁（红线2——退役/拆分/续期零自动执行，自动窄口只属票09）。
 */
export type PatrolFindingKind = "contradiction" | "stale" | "orphan" | "missing-page" | "missing-xref" | "case-backlog" | "index-budget" | "low-confidence" | "bloat" | "zombie" | "domain-skew" | "volatile-expired"

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

// ── P4 票08 数值查阈值（运营参数单源，「参数不是架构」case-symptom 同律）──
// 调整口径走 SCHEMA.md 人工同步（人机共演面——真盘文件由 owner 落笔，自动通道永不改写）。

/** 膨胀预警线：L1 容量闸（120 行/25 规则/2000 token）水位 ≥ 本比例 ⇒ bloat finding（故事 9，等号含）。 */
export const BLOAT_WATERLINE_RATIO = 0.8

/** 僵尸判据：连续零引用天数 ≥ 本值 ⇒ zombie finding（故事 11 逐字「90 天」）。 */
export const ZOMBIE_DORMANT_DAYS = 90

/** 域失衡份额闸：单页锚点占全库 **>** 本值 ⇒ domain-skew finding（故事 12 逐字「>30%」）。 */
export const DOMAIN_SKEW_SHARE_THRESHOLD = 0.3

/** 域失衡低水位门槛：全库锚点总数 < 本值不判（小库份额无统计意义，防假阳性）。 */
export const DOMAIN_SKEW_MIN_TOTAL_ANCHORS = 10

const DAY_MS = 86_400_000

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
  /** P4 票07 低置信查：v3 页 front-matter 原形（非 v3=undefined；v2/判例无 confidence 快照语义） */
  page?: WikiPageFrontmatter
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
        ...(parsed.kind === "page" ? { page: parsed.meta } : {}),
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
      ...this.lowConfidenceDrafts(pages),
      ...this.bloatDrafts(pages),
      ...this.zombieDrafts(pages),
      ...this.domainSkewDrafts(pages),
      ...this.volatileExpiredDrafts(pages),
    ]
  }

  /**
   * ⑦ 低置信（P4 票07，spec 故事 5「差规则不赖账」）：实效账目聚合 confidence ≤0.2
   * 且引用 ≥3 的 v3 页 ⇒ finding 提议修订或退役。账目面=页键行 ∪ 页内锚点行
   * （与 effectiveness-sync 快照面同一 rollup 单源，公式零漂移）；confidence 取
   * rollupConfidence 闸值产物——未测行保持编译期初值（初值本身 ≤0.2 也按票面字面
   * 判据入列：那正是「编译期就没人信、还被用了 3 次」的最该复审面）。
   * 确定性 DB 读零 LLM（内容寻址 id 可复算=幂等根基，六查纪律原样）；处置全走
   * 既有 finding 卡三态（adopt=semanticRevision 修订通道 / ignore=不再扰），
   * 红线2：巡检只开处方不动手术。
   */
  private lowConfidenceDrafts(pages: PageView[]): PatrolDraft[] {
    const dao = new KnowledgeEffectivenessDAO(this.db)
    const byKey = new Map<string, { cited_count: number; helpful_count: number; not_helpful_count: number }>()
    try {
      for (const r of dao.listAll()) byKey.set(r.rule_id, r)
    } catch {
      return [] // 裸库无表（applySchema 之后理论不可达）⇒ 诚实空面
    }
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      if (!p.page) continue // v2/判例不在实效快照语义面（与 sync 执行体同一出列裁定）
      const seen = new Set<string>()
      const rows: Array<{ cited_count: number; helpful_count: number; not_helpful_count: number }> = []
      for (const key of [p.id, ...p.anchors]) {
        if (seen.has(key)) continue
        seen.add(key)
        const row = byKey.get(key)
        if (row) rows.push(row)
      }
      const roll = rollupEffectiveness(rows)
      if (roll.cited === 0) continue // 从未被消费：无账不催（无账页恒不低置信，判据先行短路）
      const initial = p.page.confidence ?? 0.5 // DB 兜底初值口径（pageEntryView 同律）
      const confidence = rollupConfidence(roll, initial)
      if (!isLowConfidence(roll, confidence)) continue
      drafts.push({
        id: sha16(`low-confidence|patrol|${p.relPath}`),
        kind: "low-confidence",
        title: `低置信：${p.relPath}（confidence ${confidence} · 引用 ${roll.cited}× · helpful ${roll.helpful}/not_helpful ${roll.notHelpful}）——提议修订或退役`,
        detail: JSON.stringify({
          page: p.relPath,
          anchors: p.anchors,
          cited: roll.cited,
          helpful: roll.helpful,
          not_helpful: roll.notHelpful,
          samples: roll.samples,
          measured: roll.measured,
          confidence,
        }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ⑧ 膨胀榜（P4 票08 D1，spec 故事 9「不等触顶硬拒」）：L1 容量闸口径的水位
   * （行/规则/token 三阈值先到 max，与 lintWikiPage L1 同一闸族）≥80% 的 v3 页
   * ⇒ bloat finding 预拆分提案。判例豁免同 L1 闸律（lintProfileForPageType
   * capacity:false——判例天然长）；v2 词条不判（退场轨道，同低置信查出列裁定）。
   * 读盘面与 L1 闸逐字同口径（serializePageMarkdown 后再数——防「文件尾空行」漂移）。
   */
  private bloatDrafts(pages: PageView[]): PatrolDraft[] {
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      if (!p.page || p.type === "case") continue
      const serialized = serializePageMarkdown(p.page, p.body).replace(/\n+$/, "")
      const lines = serialized.split("\n").length
      const tokens = estimateTokens(serialized)
      const rules = p.anchors.length
      const waterline = Math.max(
        lines / WIKI_LIMITS.ENTRY_MAX_LINES,
        rules / WIKI_LIMITS.ENTRY_MAX_RULES,
        tokens / WIKI_LIMITS.ENTRY_MAX_TOKENS,
      )
      if (waterline < BLOAT_WATERLINE_RATIO) continue
      const pct = Math.round(waterline * 100)
      drafts.push({
        id: sha16(`bloat|patrol|${p.relPath}`),
        kind: "bloat",
        title: `膨胀榜：${p.relPath} 容量水位 ${pct}%（L1 闸预警线 ${Math.round(BLOAT_WATERLINE_RATIO * 100)}%）——提议按 H2 小节预拆分/hub 化`,
        detail: JSON.stringify({
          page: p.relPath,
          lines,
          rules,
          tokens,
          waterline: Math.round(waterline * 1000) / 1000,
        }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ⑨ 僵尸（P4 票08 D3，spec 故事 11「90 天零引用」）：吃票06 账（cited_count/
   * last_cited 页键行∪锚点行 rollup——单源纪律，本查零自扫 JSONL）。
   * 两形态：dormant=有引用账但最近引用距今 ≥90 天；never=全无引用账且建页
   * （last_compiled）距今 ≥90 天（新页有增长提前量不误伤）。僵尸面=内容规则页
   * （entity/concept/topic；判例走自身生命周期、sources 回执非规则载体——票06
   * LEDGER_CONTENT_DIRS 与孤儿查 sources 不算入链方两条例同律）。
   * 时钟=this.now（PatrolDeps 注入，红线6）。处方=退役 finding，人裁（红线2——
   * 自动退役窄口只属票09 一条）。
   */
  private zombieDrafts(pages: PageView[]): PatrolDraft[] {
    const dao = new KnowledgeEffectivenessDAO(this.db)
    const byKey = new Map<string, { cited_count: number; last_cited: string | null }>()
    try {
      for (const r of dao.listAll()) byKey.set(r.rule_id, r)
    } catch {
      return [] // 裸库无表 ⇒ 诚实空面（低置信查同律）
    }
    const nowMs = this.now().getTime()
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      if (!p.page) continue // v2/判例不在实效账目语义面（同低置信查出列）
      if (p.type === "case" || p.type === "source") continue // 僵尸面=规则载体页
      const seen = new Set<string>()
      let cited = 0
      let lastCited: string | null = null
      for (const key of [p.id, ...p.anchors]) {
        if (seen.has(key)) continue
        seen.add(key)
        const row = byKey.get(key)
        if (!row) continue
        cited += row.cited_count
        if (row.last_cited && (lastCited === null || row.last_cited > lastCited)) lastCited = row.last_cited // ISO 字典序=时间序
      }
      let basis: "dormant" | "never"
      let days: number
      if (cited > 0 && lastCited !== null) {
        const at = Date.parse(lastCited)
        if (Number.isNaN(at)) continue
        basis = "dormant"
        days = Math.floor((nowMs - at) / DAY_MS)
      } else {
        const created = Date.parse(`${p.page.last_compiled}T00:00:00.000Z`)
        if (Number.isNaN(created)) continue
        basis = "never"
        days = Math.floor((nowMs - created) / DAY_MS)
      }
      if (days < ZOMBIE_DORMANT_DAYS) continue
      drafts.push({
        id: sha16(`zombie|patrol|${p.relPath}`),
        kind: "zombie",
        title: `僵尸页：${p.relPath} 已 ${days} 天零引用（${basis === "never" ? "从未被消费" : `最近引用 ${lastCited}`}）——提议退役`,
        detail: JSON.stringify({ page: p.relPath, basis, cited, last_cited: lastCited, dormant_days: days }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ⑩ 域失衡（P4 票08 D5，spec 故事 12「单页占全库锚点 >30%」）：锚点取数
   * PageView.anchors（scanWikiEntries 与 L1/L3 闸同一 extractRuleAnchors 源）；
   * 分母=在册全库（_retired 已在 loadPages 出列）。低水位门槛防小库假阳性。
   * 处方=hub 化/拆分 finding，人裁（红线2）。
   */
  private domainSkewDrafts(pages: PageView[]): PatrolDraft[] {
    const total = pages.reduce((n, p) => n + p.anchors.length, 0)
    if (total < DOMAIN_SKEW_MIN_TOTAL_ANCHORS) return []
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      if (p.anchors.length === 0) continue
      const share = p.anchors.length / total
      if (share <= DOMAIN_SKEW_SHARE_THRESHOLD) continue
      drafts.push({
        id: sha16(`domain-skew|patrol|${p.relPath}`),
        kind: "domain-skew",
        title: `域失衡：${p.relPath} 的 ${p.anchors.length} 条锚点占全库 ${total} 条的 ${Math.round(share * 100)}%（>30%）——提议 hub 化/拆分子页`,
        detail: JSON.stringify({
          page: p.relPath,
          anchors: p.anchors.length,
          total_anchors: total,
          share: Math.round(share * 1000) / 1000,
        }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
  }

  /**
   * ⑪ volatile 到期（P4 票08 D7，spec 故事 13）：stability=volatile 且
   * review_after < 今日 ⇒ volatile-expired 复审 finding。E2 §8 实锤：此判据
   * 此前零在跑实现（schema 字段位与编译闸在场、消费方缺席）——纯新建。
   * 续期/改写/退役**三选一在人裁侧**（finding 卡：adopt=改写案走修订通道、
   * 续期/退役=对话显式）；红线2 零自动执行。时钟 this.now（红线6，真库在册
   * volatile 页=0 属预期，判据对构造 fixture 生效即可）。
   */
  private volatileExpiredDrafts(pages: PageView[]): PatrolDraft[] {
    const today = this.now().toISOString().slice(0, 10)
    const drafts: PatrolDraft[] = []
    for (const p of [...pages].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const fm = p.page
      if (!fm || fm.stability !== "volatile" || !fm.review_after) continue
      if (fm.review_after >= today) continue
      const overdue = Math.floor((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${fm.review_after}T00:00:00.000Z`)) / DAY_MS)
      drafts.push({
        id: sha16(`volatile-expired|patrol|${p.relPath}`),
        kind: "volatile-expired",
        title: `volatile 到期：${p.relPath}（review_after ${fm.review_after} 已过 ${overdue} 天）——提议续期/改写/退役三选一裁决`,
        detail: JSON.stringify({ page: p.relPath, review_after: fm.review_after, overdue_days: overdue }),
        pages: JSON.stringify([p.relPath]),
        raw_ref: "",
        source: "patrol",
      })
    }
    return drafts
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
