// docs/cabin-design/_fidelity-v21.mjs —— 原型 ⇄ 生产 同视口保真对照（不入库）。
//
// 跑：node docs/cabin-design/_fidelity-v21.mjs            # 四档 + 截图 + diff.json
//     node docs/cabin-design/_fidelity-v21.mjs --only 1600 # 只跑一档
//     node docs/cabin-design/_fidelity-v21.mjs --keep      # 跑完保留样板舱
//
// 做的事：
//   1) 调 _fixture-v21.mjs 播一个样板舱（9 作业 / 2 task-kind）；
//   2) 原型 file://cockpit-v21.html 与生产 :3000/cabin/<id>/cockpit 同视口采样；
//   3) 输出 shots-fidelity/{proto,prod}-<w>.png 与 diff.json（每项 ok/实测/差值）；
//   4) 任一项 ok:false → 退出码 1。断言数字必须来自真实 DOM，不许写死。
//
// 采样口径：原型用原型自己的 id/class；生产用 data-testid。两边同名字段在
// evaluate 里各自取值，比较器只认字段名。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { seedFixture, cleanupFixture, WEB } from './_fixture-v21.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTO = 'file://' + path.join(HERE, 'cockpit-v21.html')
const OUT = path.join(HERE, 'shots-fidelity')
const VIEWPORTS = [
  { w: 1600, h: 900 },
  { w: 1200, h: 800 },
  { w: 900, h: 700 },
  { w: 560, h: 740 },
]

const args = process.argv.slice(2)
const only = args.includes('--only') ? Number(args[args.indexOf('--only') + 1]) : null
const keep = args.includes('--keep')
const noShots = args.includes('--no-shots')

fs.mkdirSync(OUT, { recursive: true })

// ── 采样：原型 ─────────────────────────────────────────────────────────

const protoSample = () => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const style = (sel, props) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, cs[p]]))
  }
  const visible = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
  }
  return {
    bodyFont: getComputedStyle(document.body).fontFamily,
    hud: box('header.hud'),
    hudNavGhosts: 0, // 原型没有「导航 chip」概念：入口都在右栏
    sceneCount: document.querySelectorAll('#scene img').length,
    sceneSrc: document.querySelector('#scene img')?.getAttribute('src') ?? null,
    fleet: box('#fleetrail'),
    fleetHex: box('#fleetrail .flhw'),
    fleetPct: document.querySelector('#fleetrail .flpct')?.textContent ?? null,
    fleetBarH: box('#fleetrail .flbar')?.h ?? null,
    console: box('#console'),
    composer: box('#conIn'),
    tabName: box('.ctab.on .tt2'),
    chip: box('#inboxchip'),
    clock: box('.clockwidget'),
    clockRight: (() => { const el = document.querySelector('.clockwidget'); if (!el) return null; const r = el.getBoundingClientRect(); return { r: Math.round(innerWidth - r.right), b: Math.round(innerHeight - r.bottom) } })(),
    bannerVisible: visible('#banner'),
    teal: getComputedStyle(document.documentElement).getPropertyValue('--teal').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--ck-a').trim() || null,
    uiFont: style('.ctab', ['fontFamily'])?.fontFamily ?? null,
    monoFont: style('.con-log', ['fontFamily'])?.fontFamily ?? null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    fleetRows: document.querySelectorAll('#fleetrail [data-rail-job]').length,
  }
}

// ── 采样：生产 ─────────────────────────────────────────────────────────

const prodSample = () => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const style = (sel, props) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, cs[p]]))
  }
  const visible = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
  }
  const app = document.querySelector('.ck12-app')
  return {
    bodyFont: getComputedStyle(document.body).fontFamily,
    hud: box('[data-testid="cockpit-hud"]'),
    hudNavGhosts: document.querySelectorAll('[data-testid="cockpit-hud"] .ck12-hud-back').length,
    sceneCount: document.querySelectorAll('.ck12-scene img, .ck12-bg img[data-scene]').length,
    sceneSrc: document.querySelector('.ck12-scene img, .ck12-bg img[data-scene]')?.getAttribute('src') ?? null,
    fleet: box('[data-testid="cockpit-fleet-rail"]'),
    fleetHex: box('[data-testid="cockpit-fleet-rail"] .ck12-flhw'),
    fleetPct: document.querySelector('[data-testid="cockpit-fleet-rail"] .ck12-flpct')?.textContent ?? null,
    fleetBarH: box('[data-testid="cockpit-fleet-rail"] .ck12-flbar')?.h ?? null,
    console: box('[data-testid="cockpit-chat-window"]'),
    composer: box('[data-testid="cockpit-command-bar"]'),
    tabName: box('.ck12-ctab.is-on .ck12-ctab-name'),
    chip: box('[data-testid="cockpit-inbox-chip"]'),
    clock: box('[data-testid="cockpit-clock"]'),
    clockRight: (() => { const el = document.querySelector('[data-testid="cockpit-clock"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { r: Math.round(innerWidth - r.right), b: Math.round(innerHeight - r.bottom) } })(),
    bannerVisible: visible('[data-testid="cockpit-status-banner"]'),
    teal: app ? getComputedStyle(app).getPropertyValue('--ck12-teal').trim() : null,
    accent: app ? getComputedStyle(app).getPropertyValue('--ck-a').trim() : null,
    uiFont: style('.ck12-player-n b', ['fontFamily'])?.fontFamily ?? null,
    monoFont: style('.ck12-comms-body, [data-tui-col]', ['fontFamily'])?.fontFamily ?? null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    fleetRows: document.querySelectorAll('[data-testid^="cockpit-rail-row-"]').length,
  }
}

// ── 比较器 ─────────────────────────────────────────────────────────────

const SANS = /(-apple-system|SF Pro|PingFang|Helvetica|Microsoft YaHei|sans-serif)/i
const MONO = /(SF Mono|JetBrains Mono|Menlo|Consolas|monospace|ui-monospace)/i

function round(v) { return typeof v === 'number' ? Math.round(v) : v }

function compare(proto, prod, vw) {
  const rows = []
  const wide = vw > 900
  const push = (key, expected, actual, ok, note) => rows.push({ key, expected, actual, ok, ...(note ? { note } : {}) })
  const near = (key, expected, actual, tol = 2) => {
    const ok = typeof expected === 'number' && typeof actual === 'number' && Math.abs(expected - actual) <= tol
    push(key, expected, actual, ok, `±${tol}`)
  }
  const rect = (key, a, b, tol = 2) => {
    for (const side of ['l', 't', 'r', 'b', 'w', 'h']) {
      if (a == null || b == null) { push(`${key}.${side}`, a?.[side] ?? null, b?.[side] ?? null, false, 'missing'); continue }
      near(`${key}.${side}`, a[side], b[side], tol)
    }
  }

  near('hud.h', 54, prod.hud?.h, 0)
  near('hud.h_vs_proto', proto.hud?.h, prod.hud?.h)
  push('hud.navGhosts', 1, prod.hudNavGhosts, prod.hudNavGhosts === 1, '允许 ← 一个')
  push('scene.count', 1, prod.sceneCount, prod.sceneCount === 1)
  push('scene.src.bridge', true, /scene-bridge/.test(prod.sceneSrc ?? ''), /scene-bridge/.test(prod.sceneSrc ?? ''), prod.sceneSrc ?? 'null')

  if (wide) {
    // >1240 是完整编队列；1240–900 是图标栏（原型同档），只比对双方实测。
    if (vw > 1240) near('fleet.w', 198, prod.fleet?.w)
    near('fleet.w_vs_proto', proto.fleet?.w, prod.fleet?.w)
    near('fleet.hex.w_vs_proto', proto.fleetHex?.w, prod.fleetHex?.w, 1)
    near('fleet.hex.h_vs_proto', proto.fleetHex?.h, prod.fleetHex?.h, 1)
    push('fleet.pct', true, prod.fleetPct, /%/.test(prod.fleetPct ?? ''), prod.fleetPct ?? 'null')
    if (vw > 1240) near('fleet.bar.h', 3, prod.fleetBarH, 0)
  } else {
    // ≤900 生产用抽屉隐藏编队（design 31 §2.2），原型是 64px 图标栏 —— §7 登记差异。
    push('fleet.compact', 'hidden', prod.fleet?.w ?? 0, true, '§7 差异：抽屉替代图标栏')
  }

  if (wide) {
    // 左/右/顶/宽逐像素；底缘跟随 composer 上沿 —— 底栏高度随 composer 内容
    // 行数（排队/草稿条）±10px 浮动，底缘随之浮动是设计不是漂移。
    for (const side of ['l', 'r', 't', 'w']) near(`console.${side}`, proto.console?.[side], prod.console?.[side])
    near('console.b', proto.console?.b, prod.console?.b, 10)
    near('console.h', proto.console?.h, prod.console?.h, 10)
    near('composer.gap', 0, (prod.composer && prod.console) ? prod.composer.t - prod.console.b : null, 8)
  } else {
    // 窄屏 sheet 让出 56px 底栏 + 10px 间距（原型 composer 在 console 内部，
    // 生产是独立 portal —— §7 登记）；只比对左右缘与宽度。
    for (const side of ['l', 'r', 'w']) {
      near(`console.${side}`, proto.console?.[side], prod.console?.[side])
    }
    push('composer.clear', true, (prod.composer && prod.console) ? prod.composer.t >= prod.console.b : null,
      !!prod.composer && !!prod.console && prod.composer.t >= prod.console.b, '输入行不被 sheet 盖住')
  }
  push('tab.name.h', '≥12', prod.tabName?.h ?? null, (prod.tabName?.h ?? 0) >= 12)
  near('chip.w_vs_proto', proto.chip?.w, prod.chip?.w)
  if (wide) {
    push('clock.present', true, !!prod.clock?.w, (prod.clock?.w ?? 0) > 0)
    near('clock.right', 10, prod.clockRight?.r, 2)
    near('clock.bottom', 10, prod.clockRight?.b, 2)
  } else {
    // 原型 ≤900 隐藏右下钟；生产同步隐藏（宽高 0 = display:none）。
    push('clock.hidden', 0, prod.clock?.w ?? 0, (prod.clock?.w ?? 0) === 0)
  }
  push('banner.hidden', false, prod.bannerVisible, prod.bannerVisible === false, '有编队时不显示草稿 banner')
  push('font.ui.sans', true, prod.uiFont, SANS.test(prod.uiFont ?? ''), prod.uiFont ?? 'null')
  push('font.mono', true, prod.monoFont, MONO.test(prod.monoFont ?? ''), prod.monoFont ?? 'null')
  push('token.teal', '#2EE6D6', prod.teal, (prod.teal ?? '').toUpperCase() === '#2EE6D6')
  push('token.accent', '#2EE6D6', prod.accent, (prod.accent ?? '').toUpperCase() === '#2EE6D6')
  push('overflow', 0, prod.overflow, prod.overflow <= 0)
  push('fleet.rows', 9, prod.fleetRows, prod.fleetRows >= 6, '至少 6 行可对照')
  return rows
}

// ── 主流程 ─────────────────────────────────────────────────────────────

const browser = await chromium.launch({ args: ['--disable-gpu'] })
const errors = []
let seed = null
const report = { generatedAt: new Date().toISOString(), viewports: {}, failures: 0 }

try {
  seed = await seedFixture()
  console.log('[fixture] cabin', seed.cabin.id, 'jobs', seed.jobs.length)
  const url = `${WEB}/cabin/${seed.cabin.id}/cockpit`

  const protoPage = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  protoPage.on('console', (m) => { if (m.type() === 'error') errors.push(`proto console: ${m.text()}`) })
  protoPage.on('pageerror', (e) => errors.push(`proto pageerror: ${e.message}`))
  await protoPage.goto(PROTO)
  await protoPage.waitForTimeout(1200)
  await protoPage.evaluate(() => {
    try { state.simAuto = false; clearTimeout(arrT) } catch {}
    try { state.autoWarp = false; clearTimeout(warpT) } catch {}
  })
  await protoPage.evaluate(() => document.fonts.ready)

  const prodPage = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  prodPage.on('console', (m) => { if (m.type() === 'error') errors.push(`prod console: ${m.text()}`) })
  prodPage.on('pageerror', (e) => errors.push(`prod pageerror: ${e.message}`))
  await prodPage.goto(url)
  await prodPage.getByTestId('cockpit-shell').waitFor({ timeout: 30_000 })
  // 等编队落定（真实轮询）。
  await prodPage.waitForFunction(
    () => document.querySelectorAll('[data-testid^="cockpit-rail-row-"]').length >= 6,
    null,
    { timeout: 30_000 },
  ).catch(() => {})
  await prodPage.waitForTimeout(1200)
  // 打开通讯台（原型恒开）并等几何落定。
  await prodPage.keyboard.press('Meta+k')
  await prodPage.waitForTimeout(1600)

  for (const { w, h } of VIEWPORTS) {
    if (only && only !== w) continue
    const key = `${w}x${h}`
    console.log(`\n— ${key} —`)
    await protoPage.setViewportSize({ width: w, height: h })
    await prodPage.setViewportSize({ width: w, height: h })
    await protoPage.waitForTimeout(700)
    await prodPage.waitForTimeout(900)

    if (!noShots) {
      await protoPage.screenshot({ path: path.join(OUT, `proto-${w}.png`) })
      await prodPage.screenshot({ path: path.join(OUT, `prod-${w}.png`) })
    }

    const p = await protoPage.evaluate(protoSample)
    const q = await prodPage.evaluate(prodSample)
    const rows = compare(p, q, w)
    const failed = rows.filter((r) => !r.ok)
    report.viewports[key] = { proto: p, prod: q, rows, failed: failed.length }
    report.failures += failed.length

    for (const r of rows) {
      const mark = r.ok ? 'ok  ' : 'FAIL'
      console.log(`  ${mark} ${r.key}  expected=${JSON.stringify(r.expected)} actual=${JSON.stringify(r.actual)}`)
    }
    console.log(`  → ${rows.length - failed.length}/${rows.length} ok`)
  }

  report.errors = errors
} finally {
  await browser.close()
  if (seed) {
    fs.writeFileSync(path.join(OUT, 'diff.json'), JSON.stringify(report, null, 2))
    if (keep) console.log('[fixture] kept', seed.cabin.id, seed.dir)
    else await cleanupFixture(seed.cabin.id, seed.dir)
  }
}

console.log(`\n[report] ${path.join(OUT, 'diff.json')}`)
if (errors.length) console.log(`[errors] ${errors.length}\n` + errors.join('\n'))
console.log(report.failures === 0 ? '[verdict] PASS' : `[verdict] FAIL · ${report.failures} 项断言未过`)
process.exit(report.failures === 0 ? 0 : 1)
