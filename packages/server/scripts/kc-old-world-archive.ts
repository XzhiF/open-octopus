/**
 * 旧世界归档删除 CLI（知识中心票09）— 单入口幂等命令，可重跑。
 * 真数据唯一执行面：org knowledge 各目录 + 全局旧语料归档 → 删除；
 * experiences 全量导出（JSON/CSV）→ drop 表含 FTS。顺序铁律 = 归档先于删除，
 * 冲突/失败即抛错且零删除发生；重跑幂等（源不在 skip-absent / 归档一致 skip-copy）。
 *
 * 运行（worktree/仓库 packages/server 下；schema.ts 按 __dirname 读 schema.sql，
 * 所以 sql 必须拷进输出目录）：
 *   npx tsup scripts/kc-old-world-archive.ts --format cjs --out-dir dist-scripts --external better-sqlite3
 *   cp src/db/schema.sql dist-scripts/
 *   node dist-scripts/kc-old-world-archive.js --dry-run      # 只读列计划（缺省即 dry-run）
 *   # 主控按报告 backupHint 先 VACUUM INTO 备份，再：
 *   node dist-scripts/kc-old-world-archive.js --apply
 *
 * 环境变量：
 *   OCTOPUS_DB_PATH     DB 路径（缺省 ~/.octopus/db/octopus.db）
 *   OCTOPUS_HOME        octopus home 覆盖（orgs 根 = <home>/orgs；知识根解析同 global-paths）
 *   OCTOPUS_KNOWLEDGE_DIR 全局知识根覆盖（归档区 _archive/ 落点）
 *
 * 退出码：0 = 成功（含幂等空跑）；1 = 抛错（ARCHIVE_CONFLICT / EXPORT_FAILED，
 * 此刻零删除已发生，可排查后重跑）。报告逐 org/逐表行数对账打 stdout（JSON）。
 *
 * 真数据 ops 命令序列（交付主控）：
 *   1) 本脚本 --dry-run（读报告：archiveRoot/orgDirs/experiences 行数/backupHint）
 *   2) sqlite3 "<db>" "VACUUM INTO '<db>.pre-old-world-teardown.bak'"
 *   3) 本脚本 --apply
 *   4) 重跑 --apply 验幂等（应全 skip-absent）
 */
import { initDb } from "../src/db/connection"
import { OldWorldTeardownMigrator } from "../src/services/knowledge/old-world-teardown"

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const db = initDb()
  const migrator = new OldWorldTeardownMigrator({ db, apply })
  const report = await migrator.run()
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

main().catch(err => {
  console.error(String(err && err.message ? err.message : err))
  process.exit(1)
})
