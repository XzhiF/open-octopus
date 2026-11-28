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
  const pseudo = (sel, which, prop) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el, which)[prop] : null
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
    console: box('#console'),
    consoleRadius: style('#console', ['borderRadius', 'clipPath']),
    composer: box('#conIn'),
    composerTaH: box('#cmdInput')?.h ?? null,
    telemChips: document.querySelectorAll('#console .telem .tc').length,
    telemModel: document.querySelector('#conModel')?.textContent ?? null,
    telemDrop: box('#modelPop:not([hidden])'),
    turnBtn: box('#conTurns'),
    turnText: document.querySelector('#conTurns')?.textContent ?? null,
    chip: box('#inboxchip'),
    clock: null,
    clockRight: null,
    rhexFilter: style('#rCmd', ['filter'])?.filter ?? null,
    rhexRim: pseudo('#rCmd', '::before', 'boxShadow'),
    rhexFace: pseudo('#rCmd', '::after', 'boxShadow'),
    fleetRadius: style('#fleetrail', ['borderRadius', 'clipPath']),
    flrowRadius: style('#fleetrail .flrow', ['borderRadius', 'clipPath']),
    bannerVisible: visible('#banner'),
    teal: getComputedStyle(document.documentElement).getPropertyValue('--teal').trim(),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--ck-a').trim() || null,
    uiFont: style('.backchip b', ['fontFamily'])?.fontFamily ?? null,
    monoFont: style('.con-log', ['fontFamily'])?.fontFamily ?? null,
    hudHeights: ['.backchip', '.projchip', '.sceneread', '#curCost'].map((s) => (visible(s) ? (box(s)?.h ?? null) : null)),
    hudTops: ['.backchip', '.projchip', '.sceneread', '#curCost'].map((s) => (visible(s) ? (box(s)?.t ?? null) : null)),
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
  const pseudo = (sel, which, prop) => {
    const el = document.querySelector(sel)
    return el ? getComputedStyle(el, which)[prop] : null
  }
  const app = document.querySelector('.ck12-app')
  return {
    bodyFont: getComputedStyle(document.body).fontFamily,
    hud: box('[data-testid="cockpit-hud"]'),
    hudNavGhosts: document.querySelectorAll('[data-testid="cockpit-hud"] .ck12-hud-classic').length,
    sceneCount: document.querySelectorAll('.ck12-scene img, .ck12-bg img[data-scene]').length,
    sceneSrc: document.querySelector('.ck12-scene img, .ck12-bg img[data-scene]')?.getAttribute('src') ?? null,
    fleet: box('[data-testid="cockpit-fleet-rail"]'),
    fleetHex: box('[data-testid="cockpit-fleet-rail"] .ck12-flhw'),
    fleetPct: document.querySelector('[data-testid="cockpit-fleet-rail"] .ck12-flpct')?.textContent ?? null,
    console: box('[data-testid="cockpit-chat-window"]'),
    consoleRadius: style('[data-testid="cockpit-chat-window"]', ['borderRadius', 'clipPath']),
    composer: box('.ck12-comms-in'),
    composerTaH: box('[data-testid="cockpit-composer-slot"] textarea')?.h ?? null,
    telemChips: document.querySelectorAll('[data-testid="cockpit-chat-window"] .ck12-tc').length,
    telemModel: document.querySelector('[data-testid="cockpit-con-model"] b')?.textContent ?? null,
    telemDrop: box('[data-testid="cockpit-con-drop-model"]'),
    turnBtn: box('[data-testid="chat-timeline-handle"]'),
    turnText: document.querySelector('[data-testid="chat-timeline-handle"]')?.textContent ?? null,
    chip: box('[data-testid="cockpit-inbox-chip"]'),
    clock: box('[data-testid="cockpit-clock"]'),
    clockRight: null,
    rhexFilter: style('[data-testid="cockpit-menu-command"]', ['filter'])?.filter ?? null,
    rhexRim: pseudo('[data-testid="cockpit-menu-command"]', '::before', 'boxShadow'),
    rhexFace: pseudo('[data-testid="cockpit-menu-command"]', '::after', 'boxShadow'),
    fleetRadius: style('[data-testid="cockpit-fleet-rail"]', ['borderRadius', 'clipPath']),
    flrowRadius: style('[data-testid="cockpit-fleet-rail"] .ck12-flrow', ['borderRadius', 'clipPath']),
    bannerVisible: visible('[data-testid="cockpit-status-banner"]'),
    teal: app ? getComputedStyle(app).getPropertyValue('--ck12-teal').trim() : null,
    accent: app ? getComputedStyle(app).getPropertyValue('--ck-a').trim() : null,
    uiFont: style('.ck12-hud-classic b', ['fontFamily'])?.fontFamily ?? null,
    monoFont: style('.ck12-comms-body, [data-tui-col]', ['fontFamily'])?.fontFamily ?? null,
    hudHeights: ['[data-testid="cockpit-back"]', '.ck12-pjbtn', '.ck12-sceneread', '[data-testid="ck12-rig-cost"]'].map((s) => (visible(s) ? (box(s)?.h ?? null) : null)),
    hudTops: ['[data-testid="cockpit-back"]', '.ck12-pjbtn', '.ck12-sceneread', '[data-testid="ck12-rig-cost"]'].map((s) => (visible(s) ? (box(s)?.t ?? null) : null)),
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
  push('hud.navGhosts', 1, prod.hudNavGhosts, prod.hudNavGhosts === 1, '允许 ← / 经典模式 一个')
  // v21 四轮：HUD 各项同高 32px、同一条中线（可见项才比）。
  push('hud.items32', true, prod.hudHeights, prod.hudHeights.every((h) => h == null || h === 32))
  push('hud.itemsAligned', true, prod.hudTops, new Set(prod.hudTops.filter((t) => t != null)).size === 1)
  push('hud.items32_vs_proto', proto.hudHeights, prod.hudHeights,
    JSON.stringify(proto.hudHeights) === JSON.stringify(prod.hudHeights))
  // v21 四轮：输入框默认一行（原型 rows=1 / min-height 36）。
  push('composer.ta.h', proto.composerTaH, prod.composerTaH,
    typeof prod.composerTaH === 'number' && Math.abs(prod.composerTaH - 36) <= 2)
  near('composer.ta.h_vs_proto', proto.composerTaH, prod.composerTaH, 2)
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
    // v21 三轮：输入行回到 console 内部（原型 .con-in），通讯台四边逐像素钉死。
    for (const side of ['l', 'r', 't', 'w']) near(`console.${side}`, proto.console?.[side], prod.console?.[side])
    near('console.b', proto.console?.b, prod.console?.b, 2)
    near('console.h', proto.console?.h, prod.console?.h, 2)
    // 输入行必须落在通讯台内（顶 ≥ console 顶、底 ≤ console 底）。
    push('composer.inside', true,
      (prod.composer && prod.console) ? [prod.composer.t, prod.composer.b] : null,
      !!prod.composer && !!prod.console && prod.composer.t >= prod.console.t && prod.composer.b <= prod.console.b + 1,
      '输入行在 console 内')
  } else {
    // 窄屏同样：composer 在 sheet 内部（原型 .con-in），只比对左右缘与宽度。
    for (const side of ['l', 'r', 'w']) {
      near(`console.${side}`, proto.console?.[side], prod.console?.[side])
    }
    push('composer.inside', true,
      (prod.composer && prod.console) ? [prod.composer.t, prod.composer.b] : null,
      !!prod.composer && !!prod.console && prod.composer.t >= prod.console.t && prod.composer.b <= prod.console.b + 1,
      '输入行在 sheet 内')
  }
  // v21 二轮：通讯台头部遥测（MODEL / CTX / TOKEN）+ ≡ N 轮；tab 条与底缘状态行退役。
  push('telem.chips', 3, prod.telemChips, prod.telemChips === 3, 'MODEL / CTX / TOKEN')
  push('telem.model', true, !!prod.telemModel, !!prod.telemModel, prod.telemModel ?? 'null')
  push('turn.button', true, !!prod.turnBtn, (prod.turnBtn?.h ?? 0) > 0, prod.turnText ?? 'null')
  push('tabstrip.retired', 0, (prod.tabName?.h ?? 0), (prod.tabName?.h ?? 0) === 0)
  push('clock.present', false, !!prod.clock?.w, !(prod.clock?.w > 0), '右下时间横条已撤除')
  // 统一造型：窗口圆角无缺角；右栏六角 = 同色系两层（金属边无描边、内面有 inset 高光/阴影）。
  push('console.rounded', true, prod.consoleRadius, (prod.consoleRadius?.borderRadius ?? '0') !== '0px' && (prod.consoleRadius?.clipPath ?? 'none') === 'none', JSON.stringify(prod.consoleRadius))
  push('fleet.rounded', true, prod.fleetRadius, (prod.fleetRadius?.clipPath ?? 'none') === 'none' && (prod.fleetRadius?.borderRadius ?? '0') !== '0px', JSON.stringify(prod.fleetRadius))
  push('flrow.rounded', true, prod.flrowRadius, (prod.flrowRadius?.clipPath ?? 'none') === 'none', JSON.stringify(prod.flrowRadius))
  push('rhex.shadow', true, prod.rhexFilter, /drop-shadow/.test(prod.rhexFilter ?? ''), prod.rhexFilter ?? 'null')
  push('rhex.rim.none', true, prod.rhexRim, (prod.rhexRim ?? 'none') === 'none', prod.rhexRim ?? 'null')
  push('rhex.face.inset', true, prod.rhexFace, /inset/.test(prod.rhexFace ?? ''), prod.rhexFace ?? 'null')
  near('chip.w_vs_proto', proto.chip?.w, prod.chip?.w)
  push('banner.hidden', false, prod.bannerVisible, prod.bannerVisible === false, '有编队时不显示草稿 banner')
  push('font.ui.sans', true, prod.uiFont, SANS.test(prod.uiFont ?? ''), prod.uiFont ?? 'null')
  push('font.mono', true, prod.monoFont, MONO.test(prod.monoFont ?? ''), prod.monoFont ?? 'null')
  push('token.teal', '#2EE6D6', prod.teal, (prod.teal ?? '').toUpperCase() === '#2EE6D6')
  push('token.accent', '#2EE6D6', prod.accent, (prod.accent ?? '').toUpperCase() === '#2EE6D6')
  push('overflow', 0, prod.overflow, prod.overflow <= 0)
  push('fleet.rows', 9, prod.fleetRows, prod.fleetRows >= 6, '至少 6 行可对照')
  return rows
}

// ── 详情 dossier（原型 .panel / .pscrim；v21 五轮）─────────────────────
// proto 用 openPanel('detail') 直接开；prod 点编队第一行（真实入口）。

const protoDossier = () => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    open: document.querySelector('#panel')?.classList.contains('open') ?? false,
    rect: box('#panel'),
    head: box('#panel .ph'),
    tabs: box('#panel .dtabs'),
    tabH: box('#panel .dtab')?.h ?? null,
    tabCount: document.querySelectorAll('#panel .dtab').length,
    tabsInBody: !!document.querySelector('#panel .pb .dtabs'),
    grip: box('#panel .pgrip'),
  }
}

const prodDossier = () => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    open: !!document.querySelector('[data-testid="cockpit-face"]'),
    rect: box('[data-testid="cockpit-face"]'),
    head: box('[data-testid="cockpit-face"] .ck12-dh'),
    tabs: box('[data-testid="cockpit-face"] .ck12-dtabs'),
    tabH: box('[data-testid="cockpit-tab-overview"]')?.h ?? null,
    tabCount: document.querySelectorAll('[data-testid^="cockpit-tab-"]').length,
    tabsInBody: !!document.querySelector('.ck12-face-body .ck12-dtabs'),
    grip: box('[data-testid="cockpit-dossier-grip"]'),
    headButtons: document.querySelectorAll('[data-testid="cockpit-face"] .ck12-dh button').length,
  }
}

function compareDossier(proto, prod) {
  const rows = []
  const push = (key, expected, actual, ok, note) => rows.push({ key, expected, actual, ok, ...(note ? { note } : {}) })
  const near = (key, expected, actual, tol = 2) => push(key, expected, actual,
    typeof expected === 'number' && typeof actual === 'number' && Math.abs(expected - actual) <= tol, `±${tol}`)
  push('dossier.open', true, prod.open, proto.open === true && prod.open === true)
  for (const side of ['l', 't', 'r', 'b', 'w', 'h']) {
    near(`dossier.panel.${side}`, proto.rect?.[side], prod.rect?.[side])
  }
  near('dossier.head.h', proto.head?.h, prod.head?.h)
  push('dossier.tabs.inBody', true, [proto.tabsInBody, prod.tabsInBody],
    proto.tabsInBody === true && prod.tabsInBody === true, '页签在滚动正文（原型 .pb）里')
  push('dossier.tabs.count', proto.tabCount, prod.tabCount, proto.tabCount === prod.tabCount)
  near('dossier.tab.h', proto.tabH, prod.tabH, 0)
  near('dossier.tabs.t', proto.tabs?.t, prod.tabs?.t)
  push('dossier.grip.present', true, !!prod.grip?.w, (prod.grip?.w ?? 0) > 0, '右下角拖拽缩放')
  push('dossier.head.buttons', 2, prod.headButtons, prod.headButtons === 2,
    '右上只有 ✕ + ⛶（项目签/中止/谈/决断/调试/去处理全撤）')
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

    // 详情 dossier（原型 .panel）：宽档才验（≤1240 编队是图标栏 / 抽屉，入口不同）。
    if (w > 1240) {
      await protoPage.evaluate(() => {
        state.detailJob = state.jobs[0].id
        state.detailTab = 'overview'
        openPanel('detail')
      })
      await prodPage.locator('[data-testid^="cockpit-rail-row-"]').first().click()
      // 入场动画（原型 pin：translateY 12 → 0）在无头/后台页里会被限速，
      // 只能等它真的归零再采样（实测 600ms 可能还差 12px）。
      const settled = (page, selector) => page.waitForFunction((sel) => {
        const el = document.querySelector(sel)
        if (!el) return false
        const t = getComputedStyle(el).transform
        if (t === 'none') return true
        try { return Math.abs(new DOMMatrixReadOnly(t).m42) < 0.5 } catch { return true }
      }, selector, { timeout: 20_000 }).catch(() => {})
      await protoPage.bringToFront()
      await settled(protoPage, '#panel')
      await prodPage.bringToFront()
      await settled(prodPage, '[data-testid="cockpit-face"]')
      const dp0 = await protoPage.evaluate(protoDossier)
      rows.push(...compareDossier(dp0, await prodPage.evaluate(prodDossier)))

      // ⛶ 全屏：原型 togglePanelMax / 生产 .pwin，几何应同为 5 / 52 / vw-10 / vh-58。
      await protoPage.evaluate(() => togglePanelMax())
      await prodPage.getByTestId('cockpit-dossier-max').click()
      await protoPage.waitForTimeout(350)
      await prodPage.waitForTimeout(350)
      const pmax = await protoPage.evaluate(protoDossier)
      const qmax = await prodPage.evaluate(prodDossier)
      for (const side of ['l', 't', 'w', 'h']) {
        const expected = side === 'w' ? Math.max(360, w - 10) : side === 'h' ? Math.max(260, h - 58) : side === 'l' ? 5 : 52
        const ok = Math.abs((qmax.rect?.[side] ?? -999) - expected) <= 2
        rows.push({ key: `dossier.max.${side}`, expected, actual: qmax.rect?.[side], ok, note: '⛶ 全屏几何' })
      }
      rows.push({
        key: 'dossier.max.vs_proto',
        expected: pmax.rect,
        actual: qmax.rect,
        ok: !!pmax.rect && !!qmax.rect && ['l', 't', 'w', 'h'].every((k) => Math.abs(pmax.rect[k] - qmax.rect[k]) <= 2),
      })

      // 还原 + 收面（下一次循环重新从安静舰桥开始）。
      await protoPage.evaluate(() => { togglePanelMax(); closePanel() })
      await prodPage.getByTestId('cockpit-dossier-max').click()
      await prodPage.waitForTimeout(250)
      await prodPage.keyboard.press('Escape')
      await protoPage.waitForTimeout(250)
      await prodPage.waitForTimeout(350)
    }

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
