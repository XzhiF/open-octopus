import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { KnowledgeEffectivenessDAO } from "../../db/dao/knowledge-effectiveness-dao"
import { GLOBAL_WIKI_ORG, resolveKnowledgeRoot } from "./global-paths"
import { scanWikiEntries, WikiCompileService } from "./wiki/compile"
import { parseWikiFile, serializePageMarkdown } from "./wiki/format"
import type { GitRunner } from "./wiki/wiki-git"
import type { WriteQueue } from "./wiki/compile-queue"
import { CONFIDENCE_MIN_SAMPLES, roundConfidence, rollupEffectiveness } from "./effectiveness-confidence"

/**
 * EffectivenessSyncService — P4 票07「confidence 滚动·夜巡批量刷页」执行体。
 *
 * spec Implementation Decisions：confidence 真源 = DB；页 front-matter confidence 是
 * **快照**，夜巡批量刷新（经全局串行队列新 opKind `effectiveness-sync`，单 commit
 * 收口一批 + LOG sync 行）。本服务两拍：
 *  ① DB 行级滚动（纯 DB 面，零队列）：knowledge_effectiveness.confidence 按
 *    helpful/(helpful+not_helpful) 刷已测行（DAO.recomputeSufficientConfidences，
 *    闸值单源 CONFIDENCE_MIN_SAMPLES——样本不足保持初值不抖动）。
 *  ② 页快照收口（fs+git 面，红线1 必经队列）：扫在册 v3 页，页键行 ∪ 页内锚点行
 *    聚合 → measured 页的目标值与 front-matter 现值有差 ⇒ 批通道 compilePages
 *    **一次编译 = 一个 commit**（INDEX 重建 + LOG `sync` 行 + DB/FTS 同事务全随
 *    唯一写闸既有管线，禁自拼 fs 写）；无差 ⇒ **零入队零空提交**（幂等：夜巡反复
 *    跑同库 = 第二次 no-op，git 史不多一行）。
 *
 * 出列面（事实约束，非静默吞）：
 *  - 判例（kind=case）/v2 词条：无 v3 confidence 快照语义（判例 schema 就没有该字段；
 *    v2 兼容读面已由重蒸馏收敛进 v3），不进同步面；
 *  - hub 嵌套子页（两级 relPath）：批通道 BatchPageInput 按 meta.type 单级定目录，
 *    嵌套页经批通道会被搬位——响亮跳过留 warning，DB 真源面不受影响（快照缺席=
 *    诚实，不是错值）。
 *
 * 队列形态（redistill ops 同制式）：注入 queue ⇒ enqueue 后轮询至终态（sync 是
 * 夜巡批处理步骤，作业内等收敛比 202 回执更贴「批量刷」语义）；缺省（测试未注）
 * ⇒ 直跑执行体。执行体内部再读盘面派生序列化（plan→write 间隔内页若被别的写通道
 * 搬走/改形 ⇒ 该页出列留 warning，下轮夜巡自愈）。
 */

/** 队列等待上限（批通道在跑别的写操作时的自愈口径：超时抛，夜巡腿显形不炸作业）。 */
const SYNC_QUEUE_WAIT_LIMIT_MS = 120_000
const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface SyncedPageEntry {
  relPath: string
  /** 刷新前 front-matter 现值（缺席=null，即本页此前无 confidence 行） */
  from: number | null
  to: number
}

export interface EffectivenessSyncResult {
  /** 在册 v3 单级页数（扫面数，含未入选页） */
  scannedPages: number
  /** 本轮实刷页（空=无差） */
  updated: SyncedPageEntry[]
  /** DB 行级 confidence 实改行数（①拍产物，与②拍独立） */
  rowsRecomputed: number
  changed: boolean
  commit: string | null
  queueTaskId?: string
  warnings: string[]
}

export interface EffectivenessSyncDeps {
  db: Database.Database
  /** 知识根覆盖（测试注入 tmpdir；缺省 resolveKnowledgeRoot()——patrol 同款缝） */
  root?: string
  /** 全局写串行队列（票06）。缺省=直跑执行体；生产注入全局单例（带 wiki 根锁） */
  queue?: WriteQueue
  git?: GitRunner
  now?: () => Date
}

export class EffectivenessSyncService {
  private readonly db: Database.Database
  private readonly dao: KnowledgeEffectivenessDAO
  readonly root: string
  readonly wikiRoot: string
  private readonly queue: WriteQueue | null
  private readonly git?: GitRunner
  private readonly now: () => Date
  private seq = 0

  constructor(deps: EffectivenessSyncDeps) {
    this.db = deps.db
    this.dao = new KnowledgeEffectivenessDAO(deps.db)
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.queue = deps.queue ?? null
    this.git = deps.git
    this.now = deps.now ?? (() => new Date())
  }

  async sync(): Promise<EffectivenessSyncResult> {
    // ① DB 行级滚动——纯 DB 面不过队列（记账/游标同理只写表；红线1 只约束 wiki 根写）
    const rowsRecomputed = this.dao.recomputeSufficientConfidences(CONFIDENCE_MIN_SAMPLES)

    // ② 页快照派生（读面永不锁）
    const warnings: string[] = []
    const planned = this.planSnapshot(warnings)
    const scannedPages = this.countScanned()
    if (planned.length === 0) {
      return { scannedPages, updated: [], rowsRecomputed, changed: false, commit: null, warnings }
    }

    const report: { commit: string | null; changed: boolean; touchedWarnings: string[] } = {
      commit: null,
      changed: false,
      touchedWarnings: [],
    }
    const work = async () => {
      const inputs = planned
        .map(p => {
          const abs = path.join(this.wikiRoot, p.relPath)
          try {
            const parsed = parseWikiFile(fs.readFileSync(abs, "utf-8"))
            if (parsed.kind !== "page") {
              warnings.push(`页形态漂移，本轮出列：${p.relPath}（编译通道改写了形态？下轮夜巡自愈）`)
              return null
            }
            return {
              content: serializePageMarkdown({ ...parsed.meta, confidence: p.to }, parsed.body),
              fileName: p.relPath.split("/").pop() ?? `${p.pageId}.md`,
            }
          } catch (err) {
            warnings.push(`页不可读，本轮出列：${p.relPath}（${err instanceof Error ? err.message : String(err)}）`)
            return null
          }
        })
        .filter((x): x is { content: string; fileName: string } => x !== null)
      if (inputs.length === 0) return
      // 唯一写闸四管线之批通道：INDEX 重建 + LOG sync 行 + DB/FTS 同事务 + 单 commit，
      // 幂等判脏（差 last_compiled 外零 diff ⇒ no-op）全随既有纪律，本执行体零自拼 fs 写。
      const compiler = new WikiCompileService({
        db: this.db,
        org: GLOBAL_WIKI_ORG,
        rootDir: this.wikiRoot,
        ...(this.git ? { git: this.git } : {}),
      })
      const res = await compiler.compilePages(inputs, {
        action: "sync",
        entry: `effectiveness confidence 快照（${inputs.length} 页）`,
        note: "夜巡滚动值同步：DB 真源 → front-matter 快照（票07）",
        source: "patrol",
        reviewer: "owner",
      })
      report.commit = res.commit
      report.changed = res.changed
      report.touchedWarnings = res.pages.flatMap(p => p.warnings)
    }

    // ③ 执行段：注入队列 ⇒ kind "effectiveness-sync" 入全局串行位 + 轮询至终态
    //    （redistill ops 同制式）；未注入 ⇒ 直跑（测试最小面/私有 FIFO 语义）
    let queueTaskId: string | undefined
    if (this.queue) {
      const ts = this.now().toISOString().replace(/[-:]/g, "").slice(0, 13)
      const taskId = `es-${ts}-${String(++this.seq).padStart(3, "0")}`
      const view = this.queue.enqueue("effectiveness-sync", work, {
        taskId,
        label: `effectiveness-sync: ${planned.length} 页`,
      })
      queueTaskId = view.id
      let latest = view
      for (let waitedMs = 0; ; ) {
        latest = this.queue.get(view.id) ?? latest
        if (latest.state === "committed" || latest.state === "failed") break
        if (waitedMs >= SYNC_QUEUE_WAIT_LIMIT_MS) {
          throw new Error(
            `EFFECTIVENESS_SYNC_QUEUE_TIMEOUT: 任务 ${view.id} 在 ${SYNC_QUEUE_WAIT_LIMIT_MS / 1000}s 内未达终态（队列在跑别的写操作？稍后可重查 GET /api/knowledge/wiki/queue/task/${view.id}）`,
          )
        }
        await sleepMs(10)
        waitedMs += 10
      }
      if (latest.state === "failed") {
        const code = latest.error?.code ?? "QUEUE_OP_FAILED"
        throw new Error(`${code}: ${latest.error?.message ?? "写队列任务失败"}`)
      }
    } else {
      await work()
    }

    const updated: SyncedPageEntry[] = report.changed
      ? planned.map(p => ({ relPath: p.relPath, from: p.from, to: p.to }))
      : []
    return {
      scannedPages,
      updated,
      rowsRecomputed,
      changed: report.changed,
      commit: report.commit,
      ...(queueTaskId ? { queueTaskId } : {}),
      warnings: [...warnings, ...report.touchedWarnings],
    }
  }

  /** 在册 v3 单级页扫描（判据注释见头注出列面）。 */
  private planSnapshot(warnings: string[]): Array<{ relPath: string; pageId: string; from: number | null; to: number }> {
    const out: Array<{ relPath: string; pageId: string; from: number | null; to: number }> = []
    for (const e of scanWikiEntries(this.wikiRoot)) {
      const page = e.page
      if (!page) continue // 判例/v2 词条：无 v3 confidence 快照语义，出列
      const roll = rollupEffectiveness(this.pageRows(page.id, e.anchors))
      if (!roll.measured) continue // 样本不足：保持初值不抖动（闸值单源票07）
      const to = roundConfidence(roll.helpful, roll.samples)
      if (to === page.confidence) continue // 已收敛：零差零提交
      if (e.relPath.split("/").length > 2) {
        warnings.push(`hub 嵌套子页不在快照同步面（批通道单级约束，DB 真源不受影响）：${e.relPath}`)
        continue
      }
      out.push({ relPath: e.relPath, pageId: page.id, from: page.confidence ?? null, to })
    }
    return out
  }

  private countScanned(): number {
    let n = 0
    for (const e of scanWikiEntries(this.wikiRoot)) if (e.page && e.relPath.split("/").length === 2) n++
    return n
  }

  /** 页键行 ∪ 页内锚点行（同键去重；缺席行诚实跳过）。 */
  private pageRows(pageId: string, anchors: string[]): Array<{ cited_count: number; helpful_count: number; not_helpful_count: number }> {
    const rows: Array<{ cited_count: number; helpful_count: number; not_helpful_count: number }> = []
    const seen = new Set<string>()
    for (const key of [pageId, ...anchors]) {
      if (seen.has(key)) continue
      seen.add(key)
      const row = this.dao.getByRuleId(key)
      if (row) rows.push(row)
    }
    return rows
  }
}
