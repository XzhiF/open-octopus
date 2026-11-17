// cockpit-v21 验证（四轮）：左编队单列按状态+创建时间（无「需要你」分组）/
// 右 inbox 紧凑 chip（主 chat 加宽）/ hex 实心亮色 / 关闭按钮一律左置 /
// chat 内容按终端 TUI 语法渲染（❯ / ✦+meta / ▸ tool [✓] / sys）/
// 回传 banner 移到汐音头顶上方空白 / 更多横排 / 消耗·调试常驻。
// 本机 GPU 驱动旧，截图走 --disable-gpu（ego-browser capture 在本机会超时）。
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v21.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v21');
fs.mkdirSync(shots, { recursive: true });
const errors = [];
const log = (...a) => console.log(...a);
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async n => { await page.screenshot({ path: path.join(shots, n + '.png') }); log('  shot', n); };
const wait = ms => page.waitForTimeout(ms);
const assert = (c, m) => { if (!c) { errors.push('ASSERT: ' + m); log('  FAIL', m); } else log('  ok', m); };
const railOrder = () => page.locator('#fleetrail [data-rail-job]').evaluateAll(els => els.map(e => e.dataset.railJob));

await page.goto(file);
await wait(1500);
// 关掉自动回流，保证断言确定
await page.evaluate(() => { state.simAuto = false; clearTimeout(arrT); });
await wait(300);

log('— 桌面 1600×900 —');
await shot('01-desktop');
assert(await page.locator('#fleetrail [data-rail-job]').count() === 6, '左栏编队默认 6 行（可展开）');
assert(await page.locator('#fleetrail [data-fleet-more]').count() === 1, '编队底部有「更多 +N」');
assert((await page.locator('#fleetrail [data-fleet-more]').innerText()).includes('+3'), '更多显示隐藏条数 +3');
assert(await page.locator('#fleetrail .fr-g').count() === 0, '编队为单列（无「需要你」分组头）');
assert(!(await page.locator('#fleetrail .fr-sub').innerText()).includes('待你'), '左栏摘要不再重复「待你」');
assert((await page.locator('#fleetrail .fr-sub').innerText()).includes('待命'), '左栏摘要改为 在跑 / 待命 / 归档');
assert(JSON.stringify(await railOrder()) === JSON.stringify(['j-m1', 'j-m2g', 'j-m2', 'j-edge', 'j-arch', 'j-m2x']), '编队按状态+创建时间排序（前 6）');
const glyph = await page.evaluate(() => { const el = document.querySelector('.flhg'); const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundImage }; });
assert(glyph.color === 'rgb(255, 255, 255)', '编队 hex 字形为亮色实心（不再是空心黑）');
assert(glyph.bg !== 'none' && glyph.bg.includes('gradient'), '编队 hex 有实心渐变底');
assert((await page.locator('#inboxchip').innerText()).includes('要我处理'), '右栏 inbox chip 仍标「要我处理」');
assert(await page.locator('#inboxchip .n').innerText() === '3', 'inbox 初始 3 条');
assert(await page.locator('#fan [data-fan]').count() === 7, '更多横排 7 个入口');
assert(await page.locator('.rmenu .rhex').count() === 5, '右栏常驻 5 个 hex（下指令/跃迁/消耗/调试/更多）');
assert(await page.locator('#lUsage').isVisible() && await page.locator('#lDebug').isVisible(), '消耗 / 调试 常驻可点');
log('  TUI 转录');
assert(await page.locator('#conLog .tl').count() === 0, '旧表格转录已移除');
assert(await page.locator('#conLog .tline').count() >= 3, '主对话按终端 TUI 语法渲染');
assert((await page.locator('#conLog .tline.me .p').first().innerText()) === '❯', 'TUI 用户行 ❯');
assert((await page.locator('#conLog .tline.xy .mark').first().innerText()) === '✦', 'TUI 汐音行 ✦');
assert((await page.locator('#conLog .tmeta').first().innerText()).includes('已完成'), 'TUI assistant meta 行（步数/工具/token/费用）');
assert((await page.locator('.con-f .ftui').innerText()).includes('SKIN'), '外壳标 TUI SKIN（换皮肤）');
const geo = await page.evaluate(() => {
  const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height }; };
  const cs = getComputedStyle(document.querySelector('#inboxchip'));
  return { rail: box('#fleetrail'), ch: box('#character'), con: box('#console'), chip: box('#inboxchip'), chipFlex: cs.flexDirection };
});
log('  geo', JSON.stringify(geo));
assert(geo.rail.r <= geo.ch.l, '编队不与汐音重叠');
assert(geo.con.l >= geo.ch.r - 34 && geo.con.l <= geo.ch.r, '主 chat 贴住汐音（重叠 ≤34px）');
assert(geo.con.r <= geo.chip.l - 4, '主 chat 让出右栏');
assert(geo.chip.w <= 82, 'inbox chip 收窄到 ≤82px（不再占主 chat 位置）');
assert(geo.chipFlex === 'column', 'inbox chip 竖排紧凑');
assert(geo.con.w >= 840, '主 chat 变宽（≥840px）');
assert(await page.evaluate(() => { const a = document.querySelector('.fr-all').getBoundingClientRect(); const r = document.querySelector('#fleetrail').getBoundingClientRect(); return a.right <= r.right - 8; }), '编队「全部 →」不被裁切');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, '无横向滚动');

log('— 面板关闭按钮在左 —');
await page.locator('[data-fleet-all]').click();
await wait(400);
const panelHead = await page.evaluate(() => {
  const h = document.querySelector('#panel .ph'); if (!h) return null;
  const x = h.querySelector('[data-close]'); const t = h.querySelector('.pt');
  return { first: x === h.firstElementChild, xl: Math.round(x.getBoundingClientRect().left), tl: Math.round(t.getBoundingClientRect().left) };
});
log('  panel head', JSON.stringify(panelHead));
assert(panelHead && panelHead.first && panelHead.xl < panelHead.tl, '面板 ✕ 左置（标题之前）');
await shot('10-panel-close-left');
await page.locator('#panel [data-close]').click();
await wait(300);
assert(!(await page.locator('#panel').evaluate(el => el.classList.contains('open'))), '面板左置 ✕ 可关闭');

log('— 编队更多展开 / 收起 —');
await page.locator('[data-fleet-more]').click();
await wait(300);
assert(await page.locator('#fleetrail [data-rail-job]').count() === 9, '展开后 9 行全出');
const fullOrder = await railOrder();
assert(fullOrder[0] === 'j-m1' && fullOrder[8] === 'j-m2a', '展开后仍按状态+创建时间排序');
await shot('02-fleet-expanded');
await page.locator('[data-fleet-more]').click();
await wait(200);
assert(await page.locator('#fleetrail [data-rail-job]').count() === 6, '收起回到 6 行');

log('— 编队点行进作战 / tab 与窗口关闭在左 —');
const firstJob = await page.locator('#fleetrail [data-rail-job]').first().getAttribute('data-rail-job');
await page.locator('#fleetrail [data-rail-job]').first().click();
await wait(500);
assert(await page.locator('#fleetrail [data-rail-job].on').getAttribute('data-rail-job') === firstJob, '编队当前行高亮');
assert((await page.locator('#conThread').innerText()).length > 0 && (await page.locator('#conThread').innerText()) !== '主对话', '通讯台切到该作战');
assert(await page.locator('#conLog .tline.tool').count() >= 2, '作业线程里的 doer 输出渲染为 TUI tool 行');
assert(await page.locator('#conLog .tline.tool .st.err').count() >= 1 && await page.locator('#conLog .tline.tool .st.ok').count() >= 1, 'tool 行带 ✓ / ✗ 状态');
assert(await page.locator('#conLog .tmeta').count() >= 1, '作业线程 assistant 也带 meta 行');
const tabClose = await page.evaluate(() => {
  const t = document.querySelector('.ctab.on'); if (!t) return null;
  const x = t.querySelector('.cl'); const l = t.querySelector('.tt2');
  return { first: x === t.firstElementChild, vis: getComputedStyle(x).visibility, xl: Math.round(x.getBoundingClientRect().left), ll: Math.round(l.getBoundingClientRect().left) };
});
log('  tab', JSON.stringify(tabClose));
assert(tabClose && tabClose.first && tabClose.vis === 'visible' && tabClose.xl < tabClose.ll, 'tab ✕ 左置');
await page.locator('#conPop').click();
await wait(400);
assert(await page.locator('.cwin').count() === 1, '独立窗口打开');
assert(await page.locator('.cwin .cwl .tline').count() >= 3, '独立窗口同样按 TUI 语法渲染（同一份内容）');
assert(await page.locator('.cwin .cwl .tline.tool').count() >= 2, '独立窗口保留 tool 行');
const winClose = await page.evaluate(() => {
  const h = document.querySelector('.cwh'); if (!h) return null;
  const x = h.querySelector('[data-wclose]'); const t = h.querySelector('b');
  return { first: x === h.firstElementChild, xl: Math.round(x.getBoundingClientRect().left), tl: Math.round(t.getBoundingClientRect().left) };
});
log('  win', JSON.stringify(winClose));
assert(winClose && winClose.first && winClose.xl < winClose.tl, '窗口 ✕ 在左（✕ — 标题）');
await shot('11-window-close-left');
await page.locator('.cwh [data-wclose]').click();
await wait(300);
assert(await page.locator('.cwin').count() === 0, '窗口左置 ✕ 可关闭');
await page.locator('#conBack').click();
await wait(300);

log('— inbox 浮动列表 + 就地回复（关闭在左） —');
await page.locator('#inboxchip').click();
await wait(350);
assert(await page.locator('#inboxPop').evaluate(el => el.classList.contains('on')), 'inbox 浮层打开');
assert(await page.locator('#inboxPop .ip-row').count() === 3, '浮层列出 3 条待办');
assert(await page.evaluate(() => document.querySelector('.ip-h').firstElementChild.classList.contains('ipx')), 'inbox 列表 ✕ 左置');
await shot('03-inbox-list');
const popGeo = await page.evaluate(() => {
  const p = document.querySelector('#inboxPop').getBoundingClientRect();
  const c = document.querySelector('#inboxchip').getBoundingClientRect();
  return { pR: Math.round(p.right), cL: Math.round(c.left) };
});
assert(popGeo.pR <= popGeo.cL - 4, '浮层在 chip 左侧，不压 chip');

await page.locator('#inboxPop .ip-row').first().click();
await wait(350);
assert(await page.locator('#inboxPop').evaluate(el => el.classList.contains('two')), '回复卡与列表两栏');
assert(await page.locator('#inboxPop .ipd').count() === 1, '回复卡出现');
assert(await page.locator('#inboxPop .ipd-opt').count() >= 2, '回复卡有选项');
assert(await page.evaluate(() => document.querySelector('.ipd-h').firstElementChild.classList.contains('ipd-x')), 'inbox 回复卡 ✕ 左置');
await shot('04-inbox-reply');
const countBefore = await page.locator('#inboxchip .n').innerText();
await page.locator('#inboxPop .ipd-opt').first().click();
await wait(200);
assert(await page.locator('#inboxPop .ipd-opt.on').count() === 1, '选项可选中');
assert(await page.locator('[data-inbox-submit]').isEnabled(), '选后可提交');
await page.locator('[data-inbox-submit]').click();
await wait(300);
assert(await page.locator('#inboxPop .ipd-receipt').count() === 1, '提交后就地回执');
await shot('05-inbox-receipt');
assert(await page.locator('#inboxchip .n').innerText() === String(+countBefore - 1), 'inbox 计数 -1（未跳作战线程）');
assert((await page.locator('#conThread').innerText()) === '主对话', '回复过程没切走主对话');
await wait(1600);
assert(await page.locator('#inboxPop .ip-row').count() === 2, '回执后自动回到列表');
await page.keyboard.press('Escape');
await wait(300);

log('— 更多横排 —');
await page.locator('#rMore').hover();
await wait(450);
assert(await page.locator('#fanwrap').evaluate(el => el.classList.contains('on')), '悬停更多 → 横排展开');
const fanGeo = await page.evaluate(() => {
  const more = document.querySelector('#rMore').getBoundingClientRect();
  const items = [...document.querySelectorAll('#fan .fitem')].map(el => el.getBoundingClientRect());
  const tops = [...new Set(items.map(r => Math.round(r.top)))];
  return { n: items.length, leftmost: Math.min(...items.map(r => r.left)), rightmost: Math.max(...items.map(r => r.right)), moreL: more.left, rows: tops.length };
});
log('  fan', JSON.stringify(fanGeo));
assert(fanGeo.n === 7 && fanGeo.leftmost < fanGeo.moreL - 200, '7 项向左横排展开');
assert(fanGeo.rows === 1, '桌面横排为单行');
await shot('06-more-fan');
await page.locator('#lUsage').click();
await wait(500);
assert(await page.locator('#panel').evaluate(el => el.classList.contains('open')) && (await page.locator('.ph .pt b').innerText()).includes('消耗'), '常驻「消耗」打开账本');
await page.keyboard.press('Escape');
await wait(300);
assert(!(await page.locator('#panel').evaluate(el => el.classList.contains('open'))), 'Esc 关面板');
await page.locator('#lDebug').click();
await wait(500);
assert(await page.locator('#panel').evaluate(el => el.classList.contains('open')) && (await page.locator('#panel [data-dtab="debug"]').evaluate(el => el.classList.contains('on'))), '常驻「调试」直达调试页签');
await page.keyboard.press('Escape');
await wait(300);
await page.keyboard.press('Escape');
await wait(300);

log('— 回传 banner → 汐音头顶空白 + 就地回复（关闭在左） —');
await page.locator('#btnSim').click();
await wait(800);
assert(await page.locator('#banner').evaluate(el => el.classList.contains('show')), '回传 banner 出现');
const bannerGeo = await page.evaluate(() => {
  const b = document.querySelector('#banner').getBoundingClientRect();
  const ch = document.querySelector('#character').getBoundingClientRect();
  const con = document.querySelector('#console').getBoundingClientRect();
  return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), cx: Math.round((b.left + b.right) / 2), chx: Math.round((ch.left + ch.right) / 2), cht: Math.round(ch.top), conl: Math.round(con.left) };
});
log('  banner geo', JSON.stringify(bannerGeo));
assert(bannerGeo.b <= bannerGeo.cht + 2, 'banner 在汐音头顶上方空白（不压立绘）');
assert(bannerGeo.r <= bannerGeo.conl + 2, 'banner 不压通讯台（不遮挡 chat）');
assert(Math.abs(bannerGeo.cx - bannerGeo.chx) <= 4, 'banner 居于汐音正上方');
const bannerClose = await page.evaluate(() => {
  const h = document.querySelector('.bh'); const x = document.querySelector('.bx'); const k = document.querySelector('.bk');
  return { first: x === h.firstElementChild, xl: Math.round(x.getBoundingClientRect().left), kl: Math.round(k.getBoundingClientRect().left) };
});
log('  banner', JSON.stringify(bannerClose));
assert(bannerClose.first && bannerClose.xl < bannerClose.kl, 'banner ✕ 左置');
await shot('07-arrival-banner');
await page.locator('#banner').click();
await wait(400);
assert(await page.locator('#inboxPop .ipd').count() === 1, '点 banner 直接进 inbox 回复卡');
await page.keyboard.press('Escape');
await wait(200);
await page.keyboard.press('Escape');
await wait(300);

log('— 窄屏 —');
await page.setViewportSize({ width: 1200, height: 800 });
await wait(500);
const railW = await page.locator('#fleetrail').evaluate(el => Math.round(el.getBoundingClientRect().width));
assert(railW === 64, '≤1240 编队收成图标栏');
assert(await page.locator('#fleetrail [data-rail-job]').count() === 6, '图标栏也默认 6 行');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, '1200 无横向滚动');
await shot('08-compact-1200');
await page.setViewportSize({ width: 900, height: 800 });
await wait(500);
assert(!(await page.locator('#fleetrail').isVisible()), '≤900 编队收起（右栏仍可达）');
assert(await page.locator('#inboxchip').isVisible(), '≤900 inbox 仍在');
const g900 = await page.evaluate(() => {
  const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), t: Math.round(b.top) }; };
  return { big: r('.rhex.big'), chip: r('#inboxchip'), ch: r('#character'), con: r('#console'), fleetFan: !!document.querySelector('#fan [data-fan="lFleet"]'), usage: r('#lUsage'), debug: r('#lDebug') };
});
log('  900 geo', JSON.stringify(g900));
assert(g900.big.r <= 900, '900 右栏主按钮不出屏');
assert(g900.chip.w <= 78, '900 inbox chip 紧凑');
assert(g900.ch.t >= 40, '900 汐音不被 HUD 裁掉');
assert(g900.con.r <= 812, '900 主 chat 让出窄右栏');
assert(g900.fleetFan && g900.usage.r <= 900 && g900.debug.r <= 900, '900 编队入口与常驻钮可达');
await shot('09-narrow-900');
await page.setViewportSize({ width: 560, height: 800 });
await wait(500);
const g560 = await page.evaluate(() => {
  const r = s => { const b = document.querySelector(s).getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }; };
  return { chip: r('#inboxchip'), con: r('#console'), big: r('.rhex.big'), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});
log('  560 geo', JSON.stringify(g560));
assert(g560.overflow <= 0, '560 无横向滚动');
assert(g560.chip.w <= 68, '560 inbox chip 更紧凑');
assert(g560.con.r <= 484 && g560.big.r <= 560, '560 主 chat 与右栏不重叠、不出屏');
await shot('12-narrow-560');
await page.setViewportSize({ width: 1600, height: 900 });
await wait(400);

log(errors.length ? '\nFAILED:' : '\nALL OK');
errors.forEach(e => log(' -', e));
await browser.close();
process.exit(errors.length ? 1 : 0);
