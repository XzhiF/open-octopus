/**
 * 票09 · 衰减自动退役窄口（spec 故事16/18；Implementation Decisions「衰减自动退役（窄口）」）。
 *
 * 「只进不出」的自动出口，**只开这一条窄口**（红线2：其余一切退役——低置信/域失衡/
 * volatile 到期/矛盾裁决——仍产 finding 等人裁，本模块零自动路径、零新审批态）。
 *
 * 判据（AND 三条，全部入码常量 + 理由注释；口径进报告 SCHEMA 建议）：
 *  ① **锚点 90 天零引用**（吃票06 账，cited_count/last_cited + 页级 Read 两账）：
 *     页面携带的规则锚点（`anchors[]`）与页级键（文件名 stem == front-matter id，
 *     票06 解析器键制式）在 knowledge_effectiveness **两账皆无近期命中**——行缺席、
 *     last_cited 为空、或 last_cited 早于截止线均计「窗内无名」。
 *     「90 天」要求观察窗完整：页在册时刻（front-matter last_compiled，五类页制式必填）
 *     必须早于截止线——昨日新页「零引用」是未观测而非僵尸，判据不成立（构造性保守，
 *     理由注释随常量；这条是「90 天」一词的本义，非第四判据）。
 *  ② **零活页入链**：复用票04 统一机械的命中面 cleanInboundLinks/linkPointsToPage
 *     （单源纪律：与退役执行体摘链判据永不分叉；活页=scanWikiEntries 面，_retired/ 缺席）。
 *  ③ **非人工文件**：isManualFileTarget 双保险——scan 面与 RETIRABLE_DIR_RE 本已天然
 *     不含人工文件位，闸在调用方仍显式复检（SCHEMA.md 永不入自动路）。
 *
 * 命中 → 调票04 统一退役机械（PageRetireTaskService.retire），source="auto"、
 * opKind="auto-retire"（红线1：一切写经全局 FIFO 串行队列；kind 只是审计面，机械零复制），
 * 执行 = _retired/ 迁移 + superseded + 入链摘除 + INDEX/LOG retire 行 + 单 commit 全套。
 *
 * 通知卡（AC3）：退役**发生后**经 notify 回调进知识中心对话流（生产接线=
 * appendKnowledgeSessionCards，patrol-job.ts 载体）——先斩后奏但可逆：卡面给
 * 锚点/页/判据数据/可恢复提示（恢复口令=锚点原号），非审批形态（红线2 无批准/否决钮）。
 *
 * 触发面：夜巡步骤（patrol-job.ts autoRetire 腿，挂在票06 parseLedger 腿之后——
 * 吃当夜账，账新退役才准）。幂等（红线6）：退役后页离 scan 面，重跑 candidates 自然
 * 缺席；同夜多页逐条串行入队（队列自会排），无 sleep 判据（时钟全走 deps.now）。
 */
import type Database from "better-sqlite3"
import path from "path"
import { KnowledgeEffectivenessDAO } from "../../../db/dao/knowledge-effectiveness-dao"
import { resolveKnowledgeRoot } from "../global-paths"
import { pageLedgerStem } from "../page-stem"
import { scanWikiEntries, type ScannedEntry } from "./compile"
import { isManualFileTarget } from "./manual-files"
import { RETIRABLE_DIR_RE, cleanInboundLinks, type PageRetireTaskRecord } from "./page-retire"
import { pollToTerminal } from "./compile-queue"

/**
 * 窄口观察窗（天）。口径=spec 故事 16「90 天零引用」逐字。**窗值单源（aa-fix 项②3 合一）**：
 * 票08 僵尸查（patrol.ts——旧包内私有同名常量已删，改 import 本常量）与本窄口共用此值；
 * 调窗必须同步 SCHEMA.md 命名法段注记（owner 共演面）。
 */
export const AUTO_RETIRE_WINDOW_DAYS = 90

/** LOG retire 行 note 里的判据摘要（人读审计词；执行体 source 位另钉 "auto"）。 */
export const AUTO_RETIRE_REASON = `窄口自动退役：${AUTO_RETIRE_WINDOW_DAYS} 天零引用 ∧ 零活页入链 ∧ 非人工文件`

/** 单条退役 settle 等待上限（队列串行位排队他写时给足；超时=诚实缺席不通知）。 */
const SETTLE_LIMIT_MS = 60_000

/** 判据 miss 原因（窄口负断言的可观测面：每页为何**不**自动退，全部显形进 report）。 */
export type NarrowGateMissReason =
  | "not-retirable"   // 不在可退目录面（cases/v2 存量/深层 hub 子页）
  | "no-rule-anchor"  // 零规则锚点——判据主语不存在（膨胀/孤儿类问题=finding 人裁域）
  | "manual-file"     // 人工文件双保险
  | "window-incomplete" // 在册不足 90 天——观察窗未走完，「90 天零引用」不成立
  | "recent-cited"    // 两账任一窗内有名
  | "has-inbound-links" // 活页入链存在（票04 命中面）

export interface NarrowGatePage {
  relPath: string
  pageId: string
  anchors: string[]
  /** front-matter last_compiled（YYYY-MM-DD；页形态必填制式） */
  lastCompiled: string
  /** 页级 Read 记账键（文件名 stem，票06 readPageKeys 制式） */
  pageLedgerKey: string
}

export interface AutoRetireNotice {
  /** 退役任务 id（ret-…；卡 id 锚定与恢复指认用） */
  taskId: string
  pagePath: string
  /** committed 后有值 */
  retiredPath?: string
  retireCommit?: string
  status: PageRetireTaskRecord["status"]
  /** 页携带的规则锚点（恢复口令的原料：「恢复 oct-XXX」） */
  anchors: string[]
  /** 两账最近的 last_cited（null=从未被引用记录） */
  lastCited: string | null
  /** 距上次引用的整日数（无引用记录时以在册时刻起算） */
  daysSilent: number
  /** 可恢复提示（红线2：信息+恢复口令，非审批钮） */
  restoreHints: string[]
}

export interface AutoRetireReport {
  scanned: number
  retired: AutoRetireNotice[]
  skipped: Array<{ relPath: string; reason: NarrowGateMissReason }>
  warnings: string[]
}

/** 判据求值输入（纯函数面吃账行最小形状——测试可造字面量，不碰 DB）。 */
export interface NarrowGateEvidence {
  /** 键 → last_cited（行缺席=map 无此键；last_cited 列 NULL 存 null） */
  lastCitedByKey: Map<string, string | null>
  cutoffIso: string
  /** 活页入链宿主数（票04 命中面所得） */
  inboundHostCount: number
  /** isManualFileTarget 复检值（调用方算好喂入——判据三分条全可测；现布局 scan 面
   *  天然不含人工文件位，此闸=红线「人工文件写保护不得松动」的调用方保险层） */
  isManualFile: boolean
}

/**
 * 窄口判据纯函数（AND 三条 + 窗完整构造）。返回 null=命中（可自动退役），
 * 否则给 miss 原因。expected 真相源=票面判据文字本身；此函数零 IO、零时钟读取
 * （cutoff 由调用方经注入钟推得——红线6）。
 */
export function narrowGateMissReason(page: NarrowGatePage, ev: NarrowGateEvidence): NarrowGateMissReason | null {
  if (!RETIRABLE_DIR_RE.test(page.relPath)) return "not-retirable"
  if (page.anchors.length === 0) return "no-rule-anchor"
  if (ev.isManualFile) return "manual-file"
  if (page.lastCompiled === "" || page.lastCompiled > ev.cutoffIso.slice(0, 10)) return "window-incomplete"
  const keys = [...page.anchors, page.pageLedgerKey]
  for (const k of keys) {
    if (!ev.lastCitedByKey.has(k)) continue // 行缺席=窗内无账
    const cited = ev.lastCitedByKey.get(k)
    if (cited === null) continue // 列 NULL=无从谈起，按无账保守处理（票06 制式下不出现）
    if (cited >= ev.cutoffIso) return "recent-cited"
  }
  if (ev.inboundHostCount > 0) return "has-inbound-links"
  return null
}

/** 夜巡窄口服务依赖。 */
export interface AutoRetireDeps {
  db: Database.Database
  /** 知识根（缺省 resolveKnowledgeRoot()；wiki 根 = root/wiki——patrol/page-retire 同款缝） */
  root?: string
  /** 时钟注入（窗口推 cutoff 与静默天数；红线6 禁 sleep 判据） */
  now?: () => Date
  /** 票04 统一机械入口（生产=getRetireTasks() 惰性单例；测试注入真服务钉全链） */
  retireTasks: {
    retire(input: {
      path?: string
      pageId?: string
      reason?: string
      source?: string
      opKind?: "page-retire" | "auto-retire"
    }): PageRetireTaskRecord
    get(id: string): PageRetireTaskRecord | undefined
  }
  /** 通知卡生产者（每批命中一次回调；生产=index.ts 经 appendKnowledgeSessionCards 进知识中心对话流） */
  notify?: (notices: AutoRetireNotice[]) => void | Promise<void>
}

export class AutoRetireService {
  private readonly db: Database.Database
  private readonly wikiRoot: string
  private readonly now: () => Date
  private readonly retireTasks: AutoRetireDeps["retireTasks"]
  private readonly notify?: (notices: AutoRetireNotice[]) => void | Promise<void>

  constructor(deps: AutoRetireDeps) {
    this.db = deps.db
    const root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(root, "wiki")
    this.now = deps.now ?? (() => new Date())
    this.retireTasks = deps.retireTasks
    this.notify = deps.notify
  }

  /**
   * 跑一次窄口：扫在册页 → 判据（两账 + 入链 + 人工文件复检）→ 命中逐条经
   * retire() 入全局队列（opKind=auto-retire, source=auto）→ 等终态 → notify 通知卡。
   * 单页退役失败不阻断其余（warning 显形）；notify 失败显形不炸（报对话同律）。
   */
  async run(): Promise<AutoRetireReport> {
    const report: AutoRetireReport = { scanned: 0, retired: [], skipped: [], warnings: [] }
    const nowMs = this.now().getTime()
    const cutoffIso = new Date(nowMs - AUTO_RETIRE_WINDOW_DAYS * 86_400_000).toISOString()

    // 票06 账一次读全表（库小面；两账原料=锚点键行 + 页级 Read 键行）
    const lastCitedByKey = new Map<string, string | null>()
    for (const row of new KnowledgeEffectivenessDAO(this.db).listAll()) {
      lastCitedByKey.set(row.rule_id, row.last_cited)
    }

    const entries = scanWikiEntries(this.wikiRoot)
    for (const e of entries) {
      report.scanned++
      const abs = path.resolve(this.wikiRoot, e.relPath)
      const evidencePage = toNarrowGatePage(e)
      // ②零活页入链——票04 命中面（同一判据单源；候选页自身在 scan 面内，自链不算活页入链）
      const inbound = cleanInboundLinks(this.wikiRoot, e.meta.id, e.relPath).filter(h => h.relPath !== e.relPath)
      const miss = narrowGateMissReason(evidencePage, {
        lastCitedByKey,
        cutoffIso,
        inboundHostCount: inbound.length,
        isManualFile: isManualFileTarget(this.wikiRoot, abs),
      })
      if (miss) {
        report.skipped.push({ relPath: e.relPath, reason: miss })
        continue
      }

      // 命中 → 调票04 统一机械（红线1：经全局 FIFO 队列；红线2 唯一自动写路径）
      const rec = this.retireTasks.retire({
        path: e.relPath,
        reason: AUTO_RETIRE_REASON,
        source: "auto",
        opKind: "auto-retire",
      })
      const settled = await this.settle(rec.id)
      if (!settled || settled.status === "failed") {
        report.warnings.push(`自动退役未成：${e.relPath}（${settled?.error?.code ?? "SETTLE_TIMEOUT"}）`)
        continue
      }
      const lastCited = maxLastCited(evidencePage, lastCitedByKey)
      const silentSinceMs = lastCited !== null ? Date.parse(lastCited) : Date.parse(`${evidencePage.lastCompiled}T00:00:00.000Z`)
      report.retired.push({
        taskId: rec.id,
        pagePath: e.relPath,
        retiredPath: settled.result?.retiredPath,
        retireCommit: settled.result?.retireCommit,
        status: settled.status,
        anchors: evidencePage.anchors,
        lastCited,
        daysSilent: Math.floor((nowMs - silentSinceMs) / 86_400_000),
        restoreHints: evidencePage.anchors.map(a => `恢复 ${a}`),
      })
    }

    if (report.retired.length > 0 && this.notify) {
      try {
        await this.notify(report.retired)
      } catch (err) {
        report.warnings.push(`通知卡入对话流失败（退役已成，卡补发交下轮/人查）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return report
  }

  /** 轮询任务至终态（队列异步泵；上限内无 sleep 判据——这是异步完成观测，非时间窗）。
   *  轮询共享形=compile-queue.ts pollToTerminal（aa-fix 项③）；超时=原样返回最后读数
   *  （诚实缺席不通知语义不变）。 */
  private async settle(id: string, capMs = SETTLE_LIMIT_MS): Promise<PageRetireTaskRecord | undefined> {
    const outcome = await pollToTerminal(
      () => this.retireTasks.get(id),
      (rec) => rec.status === "committed" || rec.status === "failed",
      capMs,
      20,
    )
    return outcome.settled ? outcome.value : outcome.last
  }
}

function toNarrowGatePage(e: ScannedEntry): NarrowGatePage {
  const stem = pageLedgerStem(e.relPath)
  return {
    relPath: e.relPath,
    pageId: e.meta.id,
    anchors: e.anchors,
    lastCompiled: e.meta.last_compiled ?? "",
    // 票06 制式：页级 Read 键=文件名 stem；wiki_refs 路径形态同归一此键
    // （aa-fix 项②：stem 归一单源 ../page-stem.ts——与 ledger ref-token/巡检解析键三份合一）
    pageLedgerKey: stem,
  }
}

function maxLastCited(page: NarrowGatePage, byKey: Map<string, string | null>): string | null {
  let best: string | null = null
  for (const k of [...page.anchors, page.pageLedgerKey]) {
    const v = byKey.get(k)
    if (typeof v === "string" && (best === null || v > best)) best = v
  }
  return best
}
