#!/usr/bin/env node
// 场景清单单一真源 → 原型 `const SCENES=[...]` 块。
//
//   真源：docs/cabin-design/assets/scenes.json（生产 scene-model.ts 直接 import）
//   消费：docs/cabin-design/cockpit-v21.html（file:// 下不能 fetch JSON，只能内联）
//
// 用法：node docs/cabin-design/assets/sync-scenes.mjs
// 只替换原型里的 SCENES 数组，其它内容不动；scene-model.test.ts 会守住漂移。

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, 'scenes.json'), 'utf8'))
const htmlPath = join(here, '..', 'cockpit-v21.html')
const html = readFileSync(htmlPath, 'utf8')

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const items = manifest.map((s) => ({
  name: q(s.name),
  short: q(s.short),
  file: q(`./assets/${s.file}`),
}))
const block = `const SCENES=[${items
  .map((x) => `{name:${x.name},short:${x.short},file:${x.file}}`)
  .join(',\n ')}];`

const re = /const SCENES=\[[\s\S]*?\];/
if (!re.test(html)) {
  console.error('cockpit-v21.html 里找不到 const SCENES=[...] 块')
  process.exit(1)
}
const next = html.replace(re, block)
if (next === html) {
  console.log(`原型已是最新（${manifest.length} 幕）`)
  process.exit(0)
}
writeFileSync(htmlPath, next)
console.log(`已同步 ${manifest.length} 幕 → cockpit-v21.html`)
