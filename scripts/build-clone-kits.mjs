// scripts/build-clone-kits.mjs
//
// 把 packages/clone-kits/<slug>/index.ts 编译到 packages/clone-kits/dist/<slug>/index.js。
// 分身工具包不参与 pnpm workspace，单独用 tsc 构建；没有 kit 时静默跳过。

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const kitsDir = path.join(root, "packages", "clone-kits")
if (!fs.existsSync(kitsDir)) process.exit(0)

const kits = fs
  .readdirSync(kitsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .filter((d) => fs.existsSync(path.join(kitsDir, d.name, "index.ts")))
if (kits.length === 0) process.exit(0)

// Windows 上 node_modules/.bin/tsc 是 sh 脚本，spawn 不能直接执行（ENOENT）；
// 走 node + typescript/bin/tsc 才是全平台一致的调用方式。
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc")
execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.clone-kits.json")], {
  stdio: "inherit", cwd: root,
})
console.log(`[clone-kits] built ${kits.map((k) => k.name).join(", ")}`)
