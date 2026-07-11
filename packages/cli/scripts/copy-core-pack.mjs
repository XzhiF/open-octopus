import { cpSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, "..", "dist")
const corePackDir = join(__dirname, "..", "..", "core-pack")

if (!existsSync(corePackDir)) {
  console.error("core-pack not found at", corePackDir)
  process.exit(1)
}

const subdirs = ["config", "presets", "workflows", "skills", "agents", "scripts", "templates"]

for (const subdir of subdirs) {
  const src = join(corePackDir, subdir)
  const dest = join(distDir, "core-pack", subdir)
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true })
    console.log(`Copied core-pack/${subdir}/ -> dist/core-pack/${subdir}/`)
  }
}