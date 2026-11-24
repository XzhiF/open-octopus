// packages/server/src/__tests__/clone-kit-boundary.test.ts
//
// 依赖方向硬约束（clone-dev）：kit → 核心 允许；核心 → kit 禁止。
// 扫描核心包源码里的 import/require，出现 clone-kits 即失败。

import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../..")
const CORE = ["packages/shared/src", "packages/server/src", "packages/engine/src", "packages/web-app"]
const PATTERN = /(?:import|require)[^'"\n]*['"][^'"]*clone-kits/

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      walk(full, out)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe("clone-kit 依赖方向", () => {
  it("核心包不得 import packages/clone-kits", () => {
    const offenders: string[] = []
    for (const rel of CORE) {
      for (const file of walk(path.join(ROOT, rel))) {
        if (file.includes("__tests__")) continue
        const src = fs.readFileSync(file, "utf-8")
        if (PATTERN.test(src)) offenders.push(path.relative(ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })

  it("kit 之间不得互相 import", () => {
    const kitsDir = path.join(ROOT, "packages/clone-kits")
    const offenders: string[] = []
    for (const name of fs.readdirSync(kitsDir)) {
      if (name.startsWith("_")) continue
      const dir = path.join(kitsDir, name)
      if (!fs.statSync(dir).isDirectory()) continue
      for (const file of walk(dir)) {
        const src = fs.readFileSync(file, "utf-8")
        for (const m of src.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1]
          if (!spec.startsWith(".")) continue
          const resolved = path.resolve(path.dirname(file), spec)
          const rel = path.relative(kitsDir, resolved)
          if (!rel.startsWith("_sdk") && !rel.startsWith(name)) offenders.push(`${name}: ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
