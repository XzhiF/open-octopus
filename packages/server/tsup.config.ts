import { defineConfig } from "tsup"
import { cpSync, existsSync, mkdirSync } from "fs"
import { join } from "path"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  noExternal: [],
  external: ["yjs", "y-protocols", "lib0", "ws", "chokidar", "y-websocket"],
  onSuccess: async () => {
    // Copy schema.sql to dist/ so it's available at runtime.
    // schema.ts uses createRequire(import.meta.url) to resolve ./schema.sql,
    // which means the .sql file must sit alongside schema.js in dist/.
    // schema.ts uses path.join(_dirname, "schema.sql") where _dirname = dist/
    const src = join("src", "db", "schema.sql")
    const dest = join("dist", "schema.sql")
    if (existsSync(src)) {
      cpSync(src, dest)
    }
    // P1 遗留接线：PG 迁移器同款拷贝 —— db/pg/migrate.ts readPgSchemaSql() 在打包态
    // 先试 dist/pg/schema.sql（dist/schema.sql 是 SQLite 那份，重名不同内容，
    // migrate.ts 内置 PG 方言标记校验防误读）。
    const pgSrc = join("src", "db", "pg", "schema.sql")
    const pgDestDir = join("dist", "pg")
    if (existsSync(pgSrc)) {
      mkdirSync(pgDestDir, { recursive: true })
      cpSync(pgSrc, join(pgDestDir, "schema.sql"))
    }
  },
})
