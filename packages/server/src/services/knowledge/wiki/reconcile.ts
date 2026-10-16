import type Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { GLOBAL_WIKI_ORG, getGlobalWikiRoot, resolveGlobalWikiRoot } from "../global-paths"
import { parseWikiFile } from "./format"
import { computeArticleLinks } from "./lint"
import { scanWikiEntries, type ScannedEntry } from "./compile"
import { WikiArticleDAO, type WikiArticleUpsert } from "../../../db/dao/wiki-article-dao"

/**
 * Wiki 索引对账（归档资产化票01 · spec 故事 27）——默认库 wiki_articles + FTS
 * 与真盘收敛：扫盘（scanWikiEntries 单源，与 redistill DB 阶段/patrol/findings 同口径）
 * 重建指定 DB 的索引层。
 *
 * 口径（对既有索引逻辑零平行造轮，逐条对齐 redistill.reconcileDb）：
 * - 盘 = 唯一真相：缺行补、漂移改、多余删（含 org ≠ global 的历史残行——票03 D6①
 *   全局钉 org 后非 global 行皆为残迹）；与盘一致的行**不重写**（幂等零变更的根基）；
 * - 行字段派生 = compile 批通道同款（domain 取扫描分型 e.type 五类值；判例经
 *   caseEntryView 切 'case'、title/summary=symptom、last_compiled=文件名日期；
 *   body 取 parseWikiFile 归一正文）；
 * - id 去重取 page/case 视图优先（同 redistill :696-701——脏态 v2 残留与 v3 活页同号）；
 * - FTS 蓝绿重建派生自现表 DDL（redistill :761-768 同款，不复制 schema 文本）；
 * - 行数对账入事务：任何不一致整段回滚，不留 DB 半态（教训 D-2 纪律）；
 * - 空盘护栏：盘 0 页而库有行 ⇒ 拒跑抛错——防 wiki 根误配把生产索引清空。
 *
 * 红线：只写 DB 索引层；绝不写 wiki git 仓 / raw / 知识根文件（本模块零 fs 写，
 * 不属于 wiki 文件写路径，不占全局串行写闸）。
 */

export interface ReconcileOptions {
  /** wiki 根（盘真源）。生产默认 = resolveGlobalWikiRoot()；测试/ops 注入 tmpdir。 */
  wikiRoot: string
  /** 钉写 org（默认 GLOBAL_WIKI_ORG='global'）。 */
  org?: string
}

export interface ReconcileReport {
  wikiRoot: string
  org: string
  /** 盘上活页数（去重 id 口径）。 */
  diskPages: number
  diskByType: Record<string, number>
  beforeTotal: number
  beforeByType: Record<string, number>
  afterTotal: number
  afterByType: Record<string, number>
  ftsRows: number
  /** 变更清单（ops 报告面：逐 id，可贴票 Comments）。 */
  inserted: string[]
  updated: string[]
  deleted: Array<{ org: string; id: string }>
}

/** 盘 → 目标行（字段派生对齐 compile 批通道 :726-739 / redistill :740-753）。 */
function desiredRow(org: string, wikiRoot: string, e: ScannedEntry): WikiArticleUpsert {
  const { body } = parseWikiFile(fs.readFileSync(path.join(wikiRoot, e.relPath), "utf-8"))
  return {
    org,
    id: e.meta.id,
    domain: e.type,
    title: e.meta.title,
    summary: e.meta.summary,
    topics: JSON.stringify(e.meta.topics),
    stability: e.meta.stability ?? "stable",
    last_compiled: e.meta.last_compiled,
    sources: JSON.stringify(e.meta.sources),
    confidence: e.meta.confidence ?? 0.5,
    body,
    path: e.relPath,
    // 链接面随盘对账同步（改版 code-review S2：清单外写通道不得让 links 掉队）
    links: computeArticleLinks(e.page?.links, body),
  }
}

export interface ReconcileConfig {
  dbPath: string
  wikiRoot: string
}

/**
 * 对账目标解析（票面纪律：DB 路径**必填**，拒绝无参直跑默认库）——
 * 参数 `--db` > env `OCTOPUS_DB_PATH`，两者皆无 ⇒ 抛错（绝不静默落
 * `~/.octopus/db/octopus.db`，ops 打错现场比打错库便宜）。
 * wiki 根：`--wiki-root`（直指 wiki 根）> env `OCTOPUS_KNOWLEDGE_DIR`（知识根，
 * wiki 根 = 根/wiki，与 global-paths 正源 env 同律）> resolveGlobalWikiRoot() 默认。
 */
export function resolveReconcileConfig(argv: string[], env: NodeJS.ProcessEnv): ReconcileConfig {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const dbPath = flag("--db") ?? env.OCTOPUS_DB_PATH
  if (!dbPath) {
    throw new Error("RECONCILE_NEEDS_DB_PATH: 必须显式给出 --db <path> 或 OCTOPUS_DB_PATH——对账脚本拒绝无参直跑默认库（防误指）")
  }
  const wikiRoot = flag("--wiki-root") ?? (env.OCTOPUS_KNOWLEDGE_DIR ? getGlobalWikiRoot(env.OCTOPUS_KNOWLEDGE_DIR) : resolveGlobalWikiRoot())
  return { dbPath, wikiRoot }
}

export function reconcileWikiIndex(db: Database.Database, opts: ReconcileOptions): ReconcileReport {
  const org = opts.org ?? GLOBAL_WIKI_ORG
  const wikiRoot = opts.wikiRoot

  // 盘真源扫描 + id 去重（page/case 视图优先——redistill D-1 同法）
  const liveById = new Map<string, ScannedEntry>()
  for (const e of scanWikiEntries(wikiRoot)) {
    const prev = liveById.get(e.meta.id)
    if (!prev || (!prev.page && !prev.case && (e.page || e.case))) liveById.set(e.meta.id, e)
  }

  const beforeRows = db
    .prepare("SELECT org, id, domain, title, summary, topics, stability, last_compiled, sources, confidence, body, path, links FROM wiki_articles ORDER BY org, id")
    .all() as Array<WikiArticleUpsert & { org: string; links: string | null }>
  const beforeTotal = beforeRows.length

  // 空盘护栏：wiki 根解析错了（0 页）而库有行 ⇒ 拒跑（防把生产索引当漂移删光）
  if (liveById.size === 0 && beforeTotal > 0) {
    throw new Error(
      `RECONCILE_REFUSE_EMPTY_DISK: 盘扫到 0 页但 wiki_articles 有 ${beforeTotal} 行——wiki 根误配？拒绝以空盘覆盖索引（wikiRoot=${wikiRoot}）`,
    )
  }

  const dao = new WikiArticleDAO(db)
  const deleted: Array<{ org: string; id: string }> = []
  const inserted: string[] = []
  const updated: string[] = []

  db.transaction(() => {
    // ① 删多余：不在盘的行 + org≠global 的残行（含同名残行）
    for (const row of beforeRows) {
      if (row.org === org && liveById.has(row.id)) continue
      db.prepare("DELETE FROM wiki_articles WHERE org = ? AND id = ?").run(row.org, row.id)
      deleted.push({ org: row.org, id: row.id })
    }
    // ② 补缺失 + 改漂移：与盘一致的行不重写（updated_at 不动 = 幂等零变更根基）
    const COLS = ["domain", "title", "summary", "topics", "stability", "last_compiled", "sources", "confidence", "body", "path"] as const
    for (const e of liveById.values()) {
      const desired = desiredRow(org, wikiRoot, e)
      const cur = beforeRows.find(r => r.org === org && r.id === e.meta.id)
      // links 列对比归一（盘侧数组 ↔ 库侧 JSON 串；未迁移行 NULL ≡ 盘无链 '[]' 不算漂移，
      // 只有「盘有链而库缺/异」才显形为漂移 ⇒ 重写自愈；防把匹配行虚报 updated）
      const linksDrift = !!cur && (cur.links ?? "[]") !== JSON.stringify(desired.links ?? [])
      if (cur === undefined) {
        dao.upsert(desired)
        inserted.push(e.meta.id)
      } else if (linksDrift || COLS.some(c => cur[c] !== desired[c])) {
        dao.upsert(desired)
        updated.push(e.meta.id)
      }
    }
    // ③ FTS 蓝绿重建（DDL 派生自现表，redistill 同款）：整表重灌 = 检索面与基表收敛
    const ftsDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wiki_fts'").get() as { sql: string } | undefined
    if (ftsDdl) {
      const cols = (db.prepare("PRAGMA table_info(wiki_fts)").all() as Array<{ name: string }>).map(c => c.name)
      const newDdl = ftsDdl.sql.replace(/\bwiki_fts\b/, "wiki_fts_reconcile")
      db.exec(newDdl)
      db.exec(`INSERT INTO wiki_fts_reconcile (rowid, ${cols.join(", ")}) SELECT rowid, ${cols.join(", ")} FROM wiki_articles`)
      db.exec("DROP TABLE wiki_fts")
      db.exec("ALTER TABLE wiki_fts_reconcile RENAME TO wiki_fts")
    }
    // ④ 行数对账入事务：不符 ⇒ 整段回滚（不留「改了一半再报错」的半态）
    const inTxTotal = (db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n
    if (inTxTotal !== liveById.size) {
      throw new Error(`RECONCILE_DB_VERIFY_FAILED: 行数对账不符（wiki_articles=${inTxTotal}，盘活页=${liveById.size}）`)
    }
  })()

  const byType = (rows: Array<{ domain: string }>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const r of rows) out[r.domain] = (out[r.domain] ?? 0) + 1
    return out
  }

  const diskByType: Record<string, number> = {}
  for (const e of liveById.values()) diskByType[e.type] = (diskByType[e.type] ?? 0) + 1

  const afterRows = db.prepare("SELECT domain FROM wiki_articles").all() as Array<{ domain: string }>

  return {
    wikiRoot,
    org,
    diskPages: liveById.size,
    diskByType,
    beforeTotal,
    beforeByType: byType(beforeRows),
    afterTotal: (db.prepare("SELECT COUNT(*) AS n FROM wiki_articles").get() as { n: number }).n,
    afterByType: byType(afterRows),
    ftsRows: (db.prepare("SELECT COUNT(*) AS n FROM wiki_fts").get() as { n: number }).n,
    inserted: inserted.sort(),
    updated: updated.sort(),
    deleted,
  }
}
