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
  // 场景图用 WebP（1440 宽，q82）：5.6 MB → 307 KB，手机上肉眼无差。
  ['assets/scene-cruise.webp', 'scenes/scene-cruise.webp'],
  ['assets/scene-deepspace.webp', 'scenes/scene-deepspace.webp'],
  // 立绘用带 alpha 的 animated WebP（VP9 的 webm 在 Flutter/Android 上会失去透明通道）。
  ['assets/v22/07-idle.webp', 'clips/07-idle.webp'],
  ['assets/v22/05-concerned.webp', 'clips/05-concerned.webp'],
  ['assets/v22/09-smile.webp', 'clips/09-smile.webp'],
  // 这张是深底半身像，只给顶栏 CrewAvatar 裁头像用；立绘只有动画一种形态，没有静态兜底。
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
