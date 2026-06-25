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
  },
})
