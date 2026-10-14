import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { resolveKnowledgeRoot } from "./global-paths"

/**
 * 票08 清理账 — pending_review 蓝绿退役（spec 故事28 · 红线1「归档先于删除」）。
 *
 * 结构强制「导出成功才 drop」：drop 语句排在导出写盘**之后**且不被 try 吞——
 * 导出（含 mkdir）任何失败都抛穿，drop 永不执行。空表也落导出件（审计面，
 * rowCount:0）。对已 drop 库幂等（跳过、不重复导出、不报错）。
 *
 * 真库 drop 由主控 ops 在合入后执行本模块的 CLI（见文件尾）；开发/测试只跑
 * in-memory fixture + tmpdir 归档目录（retire-pending-review.test.ts，S1）。
 * 本模块对 ~/.octopus 真实文件的写**仅**经 CLI 入口显式触发，函数本体不猜路径。
 */

/** 待 drop 的三索引（schema.sql 现状；drop 面须与建面逐一对齐，勿漏）。 */
const PENDING_REVIEW_INDEXES = [
  "idx_pending_status",
  "idx_pending_review_source",
  "idx_pending_review_type_status",
] as const

export interface RetireOptions {
  /** 导出件落位目录（真实 ops 传 `<知识根>/_archive`；测试传 tmpdir）。 */
  archiveDir: string
  /** 时间戳注入（测试确定性）；缺省 new Date()。 */
  now?: () => Date
}

export interface RetireResult {
  /** 表本不存在（已 drop）→ 跳过，不落导出件、不 drop、不报错。 */
  skipped: boolean
  exported: boolean
  dropped: boolean
  /** 导出行数（0 也照常落审计件）。 */
  rows: number
  /** 导出件绝对路径；skipped 时 undefined。 */
  exportPath?: string
}

/** pending_review 表是否存在（幂等判定入口）。 */
export function pendingReviewExists(db: Database.Database): boolean {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_review'`)
      .get() !== undefined
  )
}

/**
 * 全量导出 pending_review → JSON 审计件。写盘失败（含目录 mkdir）直接抛穿，
 * 由调用方中止——**不吞异常**，这是「导出成功才 drop」的实现点。
 */
function exportPendingReview(
  db: Database.Database,
  exportPath: string,
  exportedAt: string,
): { rows: number } {
  const rows = db.prepare(`SELECT * FROM pending_review ORDER BY created_at, id`).all() as Record<
    string,
    unknown
  >[]
  const userVersion = (db.pragma("user_version", { simple: true }) ?? 0) as number
  const payload = {
    table: "pending_review",
    schemaVersion: userVersion,
    rowCount: rows.length,
    exportedAt,
    rows,
  }
  fs.mkdirSync(path.dirname(exportPath), { recursive: true })
  fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), "utf-8")
  return { rows: rows.length }
}

/** drop 三索引 + 表（IF EXISTS 幂等）。仅由 retirePendingReview 在导出成功后调用。 */
function dropPendingReview(db: Database.Database): void {
  for (const idx of PENDING_REVIEW_INDEXES) db.exec(`DROP INDEX IF EXISTS ${idx}`)
  db.exec(`DROP TABLE IF EXISTS pending_review`)
}

/**
 * 蓝绿退役主流程：导出（成功才继续）→ drop。红线顺序断言的落点。
 */
export function retirePendingReview(
  db: Database.Database,
  opts: RetireOptions,
): RetireResult {
  if (!pendingReviewExists(db)) {
    return { skipped: true, exported: false, dropped: false, rows: 0 }
  }

  const now = (opts.now?.() ?? new Date()).toISOString()
  const stamp = now.replace(/[:.]/g, "-")
  const exportPath = path.join(opts.archiveDir, `pending-review-${stamp}.json`)

  // ⚠ 顺序即安全：exportPendingReview 抛穿时，下面两行永不执行（导出先于删除）。
  const { rows } = exportPendingReview(db, exportPath, now)
  dropPendingReview(db)

  return { skipped: false, exported: true, dropped: true, rows, exportPath }
}

/** 知识根下的退役归档目录（真 ops 落位；纯解析，测试注入 tmpdir 不碰真盘）。 */
export function defaultArchiveDir(injectedRoot?: string): string {
  return path.join(resolveKnowledgeRoot(injectedRoot), "_archive")
}

// ── CLI（主控 ops 合入后执行；--dry-run 只报行数/落位不 drop）────────────────
// 用法：node --import tsx <this file> [--db <path>] [--dry-run] [--archive-dir <path>]
// 绝不开 applySchema 依赖（真库此刻仍带 pending_review），直接裸开 DB 执行退役。
async function runCli(argv: string[]): Promise<void> {
  const { getDbPath } = await import("../../db/connection")
  const dryRun = argv.includes("--dry-run")
  const dbFlag = argv.indexOf("--db")
  const dbPath = dbFlag >= 0 ? argv[dbFlag + 1] : getDbPath()
  const adFlag = argv.indexOf("--archive-dir")
  const archiveDir = adFlag >= 0 ? argv[adFlag + 1] : defaultArchiveDir()

  const db = new Database(dbPath!)
  try {
    if (!pendingReviewExists(db)) {
      console.log(`[retire-pending-review] 表已不存在（幂等跳过）: ${dbPath}`)
      return
    }
    const rows = (db.prepare(`SELECT COUNT(*) AS c FROM pending_review`).get() as { c: number }).c
    if (dryRun) {
      console.log(`[retire-pending-review][dry-run] db=${dbPath} rows=${rows} 将落审计件到 ${archiveDir}，随后 drop（未执行）`)
      return
    }
    const res = retirePendingReview(db, { archiveDir })
    console.log(
      `[retire-pending-review] 已导出 ${res.rows} 行 → ${res.exportPath}；表+三索引已 drop`,
    )
  } finally {
    db.close()
  }
}

// ESM 直跑守卫（tsup/dev 下 import.meta 可用；被 ts-node/vitest import 时不触发）。
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error("[retire-pending-review] FAILED:", err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
