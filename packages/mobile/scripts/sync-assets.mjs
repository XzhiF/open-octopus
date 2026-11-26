#!/usr/bin/env node
// 素材同步：docs/cabin-design 是真源，App 里只放副本（避免双份入库）。
// 跑法：node scripts/sync-assets.mjs   （根目录另有 `pnpm mobile:assets` 转发）
//
// 只带 v1 真用得上的：2 幕场景图 + 3 支立绘（其余 10 支按需再加，控制安装包）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')                 // packages/mobile
const repoRoot = path.resolve(pkgRoot, '../..')          // repo root
const design = path.join(repoRoot, 'docs/cabin-design')

/** [源文件, 目标（相对 packages/mobile/assets）] */
const COPIES = [
  ['assets/scene-cruise.png', 'scenes/scene-cruise.png'],
  ['assets/scene-deepspace.png', 'scenes/scene-deepspace.png'],
  ['assets/v22/07-idle.webm', 'clips/07-idle.webm'],
  ['assets/v22/05-concerned.webm', 'clips/05-concerned.webm'],
  ['assets/v22/09-smile.webm', 'clips/09-smile.webm'],
  ['crew/xiyin-idle.png', 'crew/xiyin-idle.png'],
]

const iconSrc = path.join(repoRoot, 'packages/desktop/build/icon.png')
const outRoot = path.join(pkgRoot, 'assets')

function fmt(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

let total = 0
const missing = []

for (const [from, to] of COPIES) {
  const src = path.join(design, from)
  const dest = path.join(outRoot, to)
  if (!fs.existsSync(src)) {
    missing.push(src)
    continue
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  const size = fs.statSync(dest).size
  total += size
  console.log(`  + ${to.padEnd(30)} ${fmt(size)}`)
}

if (fs.existsSync(iconSrc)) {
  const dest = path.join(outRoot, 'icon/icon.png')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(iconSrc, dest)
  const size = fs.statSync(dest).size
  total += size
  console.log(`  + ${'icon/icon.png'.padEnd(30)} ${fmt(size)}   ← 与 PC exe 同一张`)
} else {
  missing.push(iconSrc)
}

console.log(`\n素材总计 ${fmt(total)}`)

if (missing.length > 0) {
  console.error('\n缺这些源文件：')
  for (const m of missing) console.error(`  - ${m}`)
  process.exitCode = 1
}
