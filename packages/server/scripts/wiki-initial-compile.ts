/**
 * 初始编译迁移 CLI（票05）— 一次性幂等命令，可重跑。
 * 与 HTTP 入口 POST /api/knowledge/wiki/migrate 共用 InitialCompileMigrator；
 * 一切写入仍经唯一闸门 WikiCompileService.compileEntry（lint/INDEX/LOG/FTS/git 同步闸）。
 *
 * 运行（worktree/仓库 packages/server 下；schema.ts 运行时按 __dirname 读
 * schema.sql，所以 sql 必须拷进输出目录）：
 *   npx tsup scripts/wiki-initial-compile.ts --format cjs --out-dir dist-scripts --external better-sqlite3
 *   cp src/db/schema.sql dist-scripts/
 *   node dist-scripts/wiki-initial-compile.js <org>
 *
 * 环境变量：
 *   OCTOPUS_DB_PATH     DB 路径（缺省 ~/.octopus/db/octopus.db）
 *   OCTOPUS_WIKI_DIR    wiki 根覆盖（缺省 ~/.octopus/orgs/<org>/knowledge/wiki）
 *   GLOSSARY_MAP_PATH   GLOSSARY-MAP.md 源覆盖（缺省 cwd/GLOSSARY-MAP.md）
 *
 * 退出码：0 = 全部成功（含幂等空跑）；1 = 有源被 lint 闸拒写（详情见 JSON failed[]，
 * 超限源的拆分提案已入审核队列 pending_review，type='wiki-split'）。
 */
import { initDb } from "../src/db/connection"
import { InitialCompileMigrator } from "../src/services/knowledge/wiki/migrate"

async function main(): Promise<void> {
  const org = process.argv[2] ?? "default"
  const db = initDb()
  const migrator = new InitialCompileMigrator({
    db,
    org,
    ...(process.env.GLOSSARY_MAP_PATH ? { glossaryMapPath: process.env.GLOSSARY_MAP_PATH } : {}),
  })
  const report = await migrator.run()
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failed.length > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
