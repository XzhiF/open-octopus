import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v20.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v20');
fs.mkdirSync(shots, { recursive: true });
const errors = [];
const log = (...a) => console.log(...a);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async n => { await page.screenshot({ path: path.join(shots, n + '.png') }); log('  shot', n); };
const wait = ms => page.waitForTimeout(ms);
const assert = (c, m) => { if (!c) { errors.push('ASSERT: ' + m); log('  FAIL', m); } else log('  ok', m); };

await page.goto(file); await wait(1800);
await shot('01-hub');
assert(await page.locator('#scA').evaluate(el => el.naturalWidth > 0), 'scene plate loaded');
assert(await page.locator('#charImg').evaluate(el => el.naturalWidth > 0), 'pose sprite loaded');
assert(await page.locator('#fPose').textContent().then(t => t === 'salute'), 'boot salute pose');
assert(await page.locator('.ctab').count() === 10, '10 tabs (main + 9 ops)');
assert(await page.locator('.rhex').count() === 4, 'right menu 4 hexes (detail lives inside ops)');
const cg = await page.evaluate(() => { const c = document.getElementById('console').getBoundingClientRect(); const m = document.querySelector('.rhex.big').getBoundingClientRect(); const l = document.querySelector('.leftstack').getBoundingClientRect(); return { cR: c.right, cL: c.left, mL: m.left, lR: l.right }; });
assert(cg.cR <= cg.mL - 4, 'console clear of right menu (' + Math.round(cg.cR) + ' <= ' + Math.round(cg.mL) + ')');
assert(cg.lR <= cg.cL, 'console clear of left stack');
assert(await page.locator('.tl .tx').first().evaluate(el => /mono/i.test(getComputedStyle(el).fontFamily)), 'TUI mono transcript body');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow desktop');

// disable auto arrival for determinism
await page.click('#lSim'); await wait(300);
await page.click('[data-sim="auto"]'); await wait(200);
await page.keyboard.press('Escape'); await wait(200);

// arrival -> banner in blank sky, not over console; auto-activate tab
await page.click('#btnSim'); await wait(900);
assert(await page.locator('#banner').evaluate(el => el.classList.contains('show')), 'banner shown');
const geo = await page.evaluate(() => { const b = document.getElementById('banner').getBoundingClientRect(); const c = document.getElementById('console').getBoundingClientRect(); const ch = document.getElementById('character').getBoundingClientRect(); return { bR: b.right, bT: b.top, bB: b.bottom, cL: c.left, chT: ch.top }; });
assert(geo.bR <= geo.cL + 2, 'banner sits in blank sky left of console (' + Math.round(geo.bR) + ' <= ' + Math.round(geo.cL) + ')');
assert(geo.bB <= geo.chT + 40, 'banner floats above character head zone');
assert(await page.locator('#conThread').textContent().then(t => t.includes('合规审计')), 'arrival auto-activates its thread');
assert(await page.locator('.ctab.on').evaluate(el => el.dataset.tab === 'j-ext'), 'active tab = arrived op job');
await shot('02-arrival-holo');

// resolve via keyboard -> happy pose + dot decrement
const opsBefore = +(await page.locator('#dotOps').textContent());
await page.keyboard.press('1'); await wait(1200);
assert(+(await page.locator('#dotOps').textContent()) === opsBefore - 1, 'resolve decrements ops dot');
assert(await page.locator('#fPose').textContent().then(t => t === 'happy'), 'pose happy on resolve');

// multi-tab reply handling: triple arrival
await page.click('#lSim'); await wait(300);
await page.click('[data-sim="triple"]'); await wait(4200);
await page.keyboard.press('Escape'); await wait(200);
assert(await page.locator('#conChoices').isVisible(), 'last arrival thread shows choices');
await shot('03-multi-tab');
await page.click('.vchoice.rec'); await wait(1000);
await page.click('[data-tab="j-m2g"]'); await wait(500);
assert(await page.locator('#conThread').textContent().then(t => t.includes('限流')), 'tab switch to M2 限流');
assert(await page.locator('#conChoices').isVisible(), 'choices for switched tab');
await page.click('.vchoice[data-label="900 rps"]'); await wait(900);

// model popover: switch model / effort / ctx
await page.click('#btnModel'); await wait(300);
assert(await page.locator('#popModel').evaluate(el => el.classList.contains('open')), 'model pop open');
await page.click('[data-model="pro-max"]'); await wait(400);
assert(await page.locator('#hModel').textContent().then(t => t === 'pro-max'), 'HUD model pro-max');
assert(await page.locator('#toast').evaluate(el => el.classList.contains('show')), 'cache-rebuild toast');
await page.click('[data-ctx="200000"]'); await wait(400);
assert(await page.locator('#hCtxTag').textContent().then(t => t === '200k'), 'ctx tag 200k');
const ctxPct = await page.locator('#hCtx').textContent();
assert(parseInt(ctxPct) > 80, 'ctx% recomputed against 200k (' + ctxPct + ')');
await page.click('[data-eff="极深"]'); await wait(300);
await shot('05-model-pop');
await page.keyboard.press('Escape'); await wait(200);

// usage ledger
await page.click('#lUsage'); await wait(500);
assert(await page.locator('.ledger').count() === 1, 'session ledger card');
assert(await page.locator('.tokc').count() === 4, '4 token cells');
assert(await page.locator('.mrow').count() >= 4, 'model + job ledger rows');
await shot('06-usage');
await page.click('.mrow[data-job]'); await wait(500);
assert(await page.locator('.dtab').count() === 6, 'ledger row -> detail');

// projects registry -> fleet filter linkage
await page.click('#btnProj'); await wait(500);
assert(await page.locator('.pcard').count() === 4, '4 project cards');
assert(await page.locator('.pnote').textContent().then(t => t.includes('ff-only')), 'read-only org note');
await shot('07-projects');
await page.click('[data-fproj-go="gateway"]'); await wait(500);
assert(await page.locator('.fchip.on').textContent().then(t => t.includes('API 网关')), 'fleet filtered to gateway');
const rowsProj = await page.locator('.frow').count();
assert(rowsProj === 3, 'gateway rows only (' + rowsProj + ')');
await page.click('.frow[data-job="j-m2g"] [data-talk]'); await wait(400);
assert(await page.locator('#conThread').textContent().then(t => t.includes('限流')), 'fleet row talk -> thread');
await page.click('#rFleet'); await wait(400);

// fleet row -> detail -> decide linkage -> files tree
await page.click('.frow[data-job="j-m1"]'); await wait(500);
assert(await page.locator('.dtab').count() === 6, '6 detail tabs incl files/debug');
assert(await page.locator('[data-decide="j-m1"]').count() === 1, 'detail has 去决断 for open op');
await page.click('[data-decide="j-m1"]'); await wait(500);
assert(await page.locator('#conChoices').isVisible(), 'detail decide -> console choices');
assert(await page.locator('#panel').evaluate(el => !el.classList.contains('open')), 'panel closed on decide');
await page.click('#conDetail'); await wait(400);
assert(await page.locator('.ph .pt b').textContent().then(t => t.includes('退款')), 'detail reopens on focus job');
assert(await page.locator('.phacts button').count() >= 3, 'detail actions compressed into header');
await page.click('[data-dtab="files"]'); await wait(400);
assert(await page.locator('.trow').count() >= 8, 'task dir tree rendered');
assert(await page.locator('.tprev pre').textContent().then(t => t.includes('t-2641')), 'default file preview');
await page.click('.trow[data-file*="spec.md"]'); await wait(400);
assert(await page.locator('.tprev pre').textContent().then(t => t.includes('phases')), 'spec preview content');
await page.fill('#fileQ', 'e2e'); await wait(400);
assert(await page.locator('.trow[data-file*="e2e"]').count() >= 1, 'filter narrows to e2e ticket');
await shot('08-files');
await page.fill('#fileQ', ''); await wait(300);

// debug inspector
await page.click('[data-dtab="debug"]'); await wait(400);
assert(await page.locator('.dbg-h').count() === 1, 'debug stats + filters on one row');
assert(await page.locator('.dbg-h .st').textContent().then(t => t.includes('轮') && t.includes('异常')), 'debug header stats');
assert(await page.locator('.rturn').count() >= 3, 'turn ruler');
await page.click('[data-turn="1"]'); await wait(300);
await page.click('[data-dsub="timeline"]'); await wait(300);
assert(await page.locator('.tlrow').count() >= 4, 'timeline events + ledger calls');
await page.click('[data-dsub="identity"]'); await wait(300);
assert(await page.locator('.idtable, .kv').count() >= 1, 'identity section');
await page.click('[data-dsub="overview"]'); await wait(300);
assert(await page.locator('.tokc').count() === 4, 'debug token split');
await page.click('[data-copy]'); await wait(600);
assert(await page.locator('#toast').evaluate(el => el.classList.contains('show')), 'snapshot copy toast');
await shot('09-debug');

// pose gallery: 12 sprites, 8 new ones live-swap with particles
await page.click('[data-close]'); await wait(300);
await page.click('#lPoses'); await wait(500);
assert(await page.locator('.posecard').count() === 12, '12 pose cards in gallery');
assert(await page.locator('.posecard .pv img').first().evaluate(el => { const r = el.getBoundingClientRect(); return r.height > 100 && r.height <= 160 && r.width <= 220; }), 'gallery thumbnails sized to card');
for (const n of ['thinking', 'worried', 'cheer', 'wink', 'sleep', 'salute', 'command', 'typing']) {
  await page.click(`[data-pose-play="${n}"]`); await wait(450);
  assert(await page.locator('#charImg').evaluate((el, n) => el.src.includes('sheet-' + n) && el.naturalWidth > 0, n), 'pose ' + n + ' sprite live on character');
}
assert(await page.locator('#charFx').evaluate(el => el.childElementCount > 0), 'pose particles emitted');
assert(await page.locator('#charImg').evaluate(el => el.src.includes('motion-sheet-typing') && el.style.height === '1200%'), '12-frame video-derived sheet active');
assert(fs.existsSync(path.join(__dirname, 'assets', 'gifs', 'xiyin-motion-idle.gif')), 'idle motion GIF delivered');
assert(fs.existsSync(path.join(__dirname, 'assets', 'gifs', 'xiyin-motion-cheer.gif')), 'cheer motion GIF delivered');
const tfs = [];
for (let i = 0; i < 5; i++) { tfs.push(await page.locator('#charImg').evaluate(el => el.style.transform)); await wait(130); }
assert(new Set(tfs).size > 1, 'sprite frame ticker alive (transform advances)');
await shot('17-poses');
await page.click('[data-close]'); await wait(300);
await page.click('#conDetail'); await wait(400);

// detail -> talk linkage
await page.click('[data-talk="j-m1"]'); await wait(500);
assert(await page.locator('#panel').evaluate(el => !el.classList.contains('open')), 'panel closed on talk');
assert(await page.locator('#conThread').textContent().then(t => t.includes('退款')), 'console on j-m1 thread');

// ops card -> detail button
await page.click('#rOps'); await wait(400);
await page.locator('[data-opdetail]').first().click(); await wait(400);
assert(await page.locator('.dtab').count() === 6, 'ops -> detail linkage');
await page.click('[data-close]'); await wait(300);

// unread badges: resolve-all from main thread
await page.click('[data-tab="main"]'); await wait(400);
await page.click('#lSim'); await wait(300);
await page.click('[data-sim="all"]'); await wait(2400);
await page.keyboard.press('Escape'); await wait(300);
assert(await page.locator('#fPose').textContent().then(t => t === 'cheer'), 'accept resolve triggers cheer pose');
const unCount = await page.locator('.ctab .un').count();
assert(unCount >= 1, 'unread badges on inactive tabs after resolve-all (' + unCount + ')');
await shot('04-unread');
await page.click('.ctab:has(.un)'); await wait(400);
assert(await page.locator('.ctab.on .un').count() === 0, 'opening tab clears its unread');

// closable tabs: close active job tab -> back to main; reopen via fleet talk
await page.click('[data-tab="j-edge"]'); await wait(300);
await page.click('[data-close-tab="j-edge"]'); await wait(400);
assert(await page.locator('[data-tab="j-edge"]').count() === 0, 'job tab closed');
assert(await page.locator('#conThread').textContent().then(t => t === '主对话'), 'closing active tab falls back to main');
await page.click('#rFleet'); await wait(400);
await page.click('[data-fproj="all"]'); await wait(300);
await page.click('.frow[data-job="j-edge"] [data-talk]'); await wait(400);
assert(await page.locator('[data-tab="j-edge"]').count() === 1, 'tab reopens from fleet talk');
// fleet -> ops jump chip
await page.click('#rFleet'); await wait(300);
await page.click('[data-ops-jump]'); await wait(300);
assert(await page.locator('.ph .pt b').textContent().then(t => t.includes('决断')), 'fleet jumps to ops');
await page.click('[data-close]'); await wait(200);

// cabin workspace tree
await page.click('#lFiles'); await wait(400);
assert(await page.locator('[data-wsproj]').count() === 4, 'workspace project chips');
assert(await page.locator('.trow').count() >= 6, 'worktree tree rendered');
await page.click('[data-wfile*="replay.ts"]'); await wait(300);
assert(await page.locator('.tprev pre').textContent().then(t => t.includes('idempotencyKey')), 'worktree file preview');
await shot('15-workspace');
await page.click('[data-ws-job="j-m1"]'); await wait(400);
assert(await page.locator('.file').count() >= 1, 'workspace file -> job changes');
await page.click('[data-close]'); await wait(200);

// dual-mode sync: main relay -> job thread; direct job chat -> main sync
await page.click('[data-tab="main"]'); await wait(300);
await page.fill('#cmdInput', '退款链路先原地修，别回滚'); await page.click('#btnSend'); await wait(1400);
await page.click('[data-tab="j-m1"]'); await wait(400);
assert(await page.locator('#conLog').textContent().then(t => t.includes('via 汐音')), 'relay lands in job thread');
await page.fill('#cmdInput', '按刚才说的继续推进'); await page.click('#btnSend'); await wait(2300);
await page.click('[data-tab="main"]'); await wait(400);
assert(await page.locator('#console').textContent().then(t => t.includes('同步：')), 'direct job chat syncs to assistant');
await shot('16-dual-sync');

// burst arrivals: consecutive messages + fleet/ops entrance animation
await page.click('#lSim'); await wait(300);
assert(await page.locator('[data-sim="warp"]').count() === 1, 'random warp toggle in sim pop');
await page.click('[data-sim="burst"]'); await wait(1200);
await page.keyboard.press('Escape'); await wait(200);
await page.click('#rFleet'); await wait(300);
assert(await page.locator('.frow.arrived').count() >= 1, 'fleet row entrance animation on arrival');
await page.click('[data-close]'); await wait(200);
await page.click('#rOps'); await wait(300);
await page.click('#btnSim'); await wait(400);
assert(+(await page.locator('#dotOps').textContent()) >= 4, 'burst delivered multiple ops');
assert(await page.locator('.ocard.arrived').count() >= 1, 'ops card entrance animation on arrival');
assert(await page.locator('#rOps').evaluate(el => el.classList.contains('hexring')), 'ops hex ring pulse on arrival');
await shot('18-burst');
await page.click('[data-close]'); await wait(300);

// console collapse / dock / resize
await page.click('#conMin'); await wait(400);
assert(await page.locator('#console').evaluate(el => el.hidden), 'console collapsed');
assert(await page.locator('#conDock').isVisible(), 'dock pill visible when collapsed');
await shot('19-docked');
await page.click('#conDock'); await wait(400);
assert(await page.locator('#console').isVisible(), 'dock click expands console');
const cb = await page.locator('#console').boundingBox();
await page.mouse.move(cb.x + 3, cb.y + cb.height / 2); await page.mouse.down();
await page.mouse.move(cb.x + 123, cb.y + cb.height / 2, { steps: 4 }); await page.mouse.up();
await wait(200);
const cb2 = await page.locator('#console').boundingBox();
assert(cb2.x > cb.x + 80, 'left grip drag resizes console (' + Math.round(cb.x) + '->' + Math.round(cb2.x) + ')');
await page.dblclick('#gripL'); await wait(200);
const cb3 = await page.locator('#console').boundingBox();
assert(Math.abs(cb3.x - cb.x) < 4, 'grip dblclick resets geometry');

// user-opened multi windows + taskbar switcher
await page.click('[data-tab="j-m2"]'); await wait(300);
await page.click('#conPop'); await wait(400);
assert(await page.locator('.cwin').count() === 1, 'first pop-out window');
assert(await page.locator('#winBar').isVisible(), 'window switcher bar visible');
await page.click('[data-tab="j-edge"]'); await wait(300);
await page.click('#conPop'); await wait(400);
assert(await page.locator('.cwin').count() === 2, 'second user-opened window');
await shot('20-windows');
await page.click('#conMin'); await wait(300);
const dg = await page.evaluate(() => { const d = document.getElementById('conDock').getBoundingClientRect(); const b = document.getElementById('winBar').getBoundingClientRect(); const c = document.querySelector('.clockwidget').getBoundingClientRect(); const hit = (x, y) => !(x.right <= y.left || y.right <= x.left || x.bottom <= y.top || y.bottom <= x.top); return { hb: hit(d, b), hc: hit(d, c) }; });
assert(!dg.hb, 'dock clear of window bar when both visible');
assert(!dg.hc, 'dock clear of clock widget');
await page.click('#conDock'); await wait(300);
await page.locator('[data-wmin]').first().click(); await wait(300);
assert(await page.locator('.cwin').count() === 1, 'minimize hides window');
assert(await page.locator('.wbchip.min').count() === 1, 'minimized chip in bar');
await page.locator('.wbchip.min').click(); await wait(300);
assert(await page.locator('.cwin').count() === 2, 'bar chip restores window');
const wta = page.locator('[data-winput]').last();
await wta.fill('窗口里直接下指令：继续灰度');
await page.locator('[data-wsend]').last().click(); await wait(900);
assert(await page.locator('.cwin').last().locator('.cwl').textContent().then(t => t.includes('窗口里直接下指令')), 'window send lands in its thread');
await page.locator('[data-wclose]').first().click(); await wait(200);
await page.locator('[data-wclose]').first().click(); await wait(300);
assert(await page.locator('.cwin').count() === 0, 'windows closed');
assert(await page.locator('#winBar').evaluate(el => el.hidden), 'bar hidden when no windows');

// warp + sound still alive
const s0 = await page.locator('#sceneName').textContent();
await page.click('#rWarp'); await wait(1200);
assert(await page.locator('#sceneName').textContent().then(t => t !== s0), 'warp works');
await page.click('.sdot[data-scene="0"]'); await wait(1000);
await page.click('#btnSound'); await wait(150);
assert(await page.locator('#btnSound').evaluate(el => el.classList.contains('off')), 'sound off');
await page.click('#btnSound'); await wait(150);

// stability: repeated tab hops + arrivals
for (let i = 0; i < 6; i++) { await page.click(`[data-tab="${['main', 'j-m2', 'j-edge', 'j-m3'][i % 4]}"]`); await wait(150); }
await page.click('#btnSim'); await wait(700);
await page.click('#btnSim'); await wait(700);
assert(await page.locator('.ctab').count() >= 10, 'tabs intact after churn');
await shot('10-final-desktop');

// tablet
await page.setViewportSize({ width: 1024, height: 768 }); await wait(700);
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow tablet');
const tg = await page.evaluate(() => { const b = document.getElementById('banner'); const r = b.getBoundingClientRect(); const c = document.getElementById('console').getBoundingClientRect(); return { bR: r.right, cL: c.left, shown: b.classList.contains('show') }; });
if (tg.shown) assert(tg.bR <= tg.cL + 2, 'tablet banner clear of console');
await shot('11-tablet');

// mobile
await page.setViewportSize({ width: 390, height: 844 }); await wait(800);
await shot('12-mobile');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow mobile');
const mg = await page.evaluate(() => { const k = document.getElementById('console').getBoundingClientRect(); return { conBot: k.bottom }; });
assert(mg.conBot <= 844, 'console within mobile viewport');
await page.click('#rCmd'); await wait(400);
const ib = await page.locator('#conIn').boundingBox();
assert(ib && ib.y + ib.height <= 844, 'input within mobile viewport');
await page.fill('#cmdInput', '移动端回应'); await page.click('#btnSend'); await wait(900);
assert(await page.locator('#conLog .tl').count() >= 4, 'mobile send works');
await page.click('#btnModel'); await wait(400);
const pm = await page.locator('#popModel').boundingBox();
assert(pm && pm.x >= 0 && pm.x + pm.width <= 390, 'model pop within mobile viewport');
await shot('13-mobile-model');
await page.keyboard.press('Escape'); await wait(200);
await page.click('[data-tab="j-m2"]'); await wait(250);
await page.click('#conPop'); await wait(300);
await page.click('#conMin'); await wait(300);
const mg2 = await page.evaluate(() => { const d = document.getElementById('conDock').getBoundingClientRect(); const b = document.getElementById('winBar').getBoundingClientRect(); const k = document.getElementById('console'); return { hit: !(d.right <= b.left || b.right <= d.left || d.bottom <= b.top || b.bottom <= d.top), conHidden: k.hidden, dIn: d.left >= 0 && d.right <= 390 }; });
assert(!mg2.hit && mg2.conHidden && mg2.dIn, 'mobile dock + window bar coexist without overlap');
await page.click('#conDock'); await wait(250);
await page.locator('[data-wclose]').first().click(); await wait(250);
await page.click('#lSim'); await wait(300);
await page.click('[data-sim="one"]'); await wait(900);
await page.keyboard.press('Escape'); await wait(200);
const bb = await page.locator('#banner').boundingBox();
assert(bb && bb.x >= 0 && bb.x + bb.width <= 390, 'mobile banner within viewport');
await shot('14-mobile-banner');

await browser.close();
log('\n=== ERRORS (' + errors.length + ') ===');
errors.forEach(e => log(' -', e));
process.exit(errors.length ? 1 : 0);