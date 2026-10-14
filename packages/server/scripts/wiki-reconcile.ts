/**
 * 归档资产化票01 · 默认库对账 ops 入口（spec 故事 27）——
 * 扫盘重建 wiki_articles + FTS，以盘为唯一真相（删多余/补缺失/改漂移/org 全 'global'）。
 *
 * 纪律（同 src/services/knowledge/wiki/reconcile.ts 头注）：
 *   - DB 路径必填：`--db <path>` 或 `OCTOPUS_DB_PATH` env，两者皆无 ⇒ 拒绝执行
 *     （绝不隐式打默认库）；
 *   - 只写 DB 索引层，零 fs 写、不跑 schema 迁移（表缺席直接抛，交人工核对现场）；
 *   - ops 前置备份：先 `cp <db> <db>.bak-reconcile-<date>`（D-2 纪律「DB=备份可逆」）。
 *
 * 运行（packages/server 下，tsup→node 先例 kc-archive-ingest-e2e.ts；本脚本不调
 * applySchema，无 schema.sql 拷贝步骤）：
 *   npx tsup scripts/wiki-reconcile.ts --format cjs --out-dir dist-scripts --external better-sqlite3 --no-dts
 *   node dist-scripts/wiki-reconcile.js --db "<绝对 DB 路径>"
 * 知识根默认走 resolveGlobalWikiRoot()（`OCTOPUS_KNOWLEDGE_DIR` env 可覆盖到 tmpdir——
 * 对账与测试共用同一覆盖缝）；也可 `--wiki-root <绝对 wiki 根>` 直指。
 *
 * 幂等：重跑第二次变更清单为空（diff 空）。行数与盘不符 ⇒ VERIFY 抛、整段回滚。
 * 退出码：0 = 对账完成（含零变更）；1 = 异常（含对账拒绝/校验失败）；2 = 参数缺失。
 */
import Database from "better-sqlite3"
import { reconcileWikiIndex, resolveReconcileConfig } from "../src/services/knowledge/wiki/reconcile"

function main(): void {
  let cfg: ReturnType<typeof resolveReconcileConfig>
  try {
    cfg = resolveReconcileConfig(process.argv.slice(2), process.env)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }

  const db = new Database(cfg.dbPath)
  db.pragma("busy_timeout = 5000")
  try {
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_articles'").get()
    if (!hasTable) {
      throw new Error(`RECONCILE_NO_WIKI_TABLES: ${cfg.dbPath} 无 wiki_articles 表——不是 octopus 库或 schema 未初始化（本脚本不跑迁移）`)
    }
    const r = reconcileWikiIndex(db, { wikiRoot: cfg.wikiRoot })
    const fmt = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ")
    process.stdout.write(`[wiki-reconcile] db=${cfg.dbPath} org=${r.org}\n`)
    process.stdout.write(`  wikiRoot=${r.wikiRoot}\n`)
    process.stdout.write(`  disk: ${r.diskPages} 页 (${fmt(r.diskByType)})\n`)
    process.stdout.write(`  before: ${r.beforeTotal} 行 (${fmt(r.beforeByType)})\n`)
    if (r.deleted.length > 0) process.stdout.write(`  deleted(${r.deleted.length}): ${r.deleted.map(d => `${d.org}/${d.id}`).join(", ")}\n`)
    if (r.inserted.length > 0) process.stdout.write(`  inserted(${r.inserted.length}): ${r.inserted.join(", ")}\n`)
    if (r.updated.length > 0) process.stdout.write(`  updated(${r.updated.length}): ${r.updated.join(", ")}\n`)
    if (r.deleted.length === 0 && r.inserted.length === 0 && r.updated.length === 0) {
      process.stdout.write("  diff: 空（幂等重跑，零变更）\n")
    }
    process.stdout.write(`  after: ${r.afterTotal} 行 == 盘 ${r.diskPages} 页 VERIFY OK | fts: ${r.ftsRows} 行\n`)
  } catch (err) {
    process.stderr.write(`[wiki-reconcile] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()
