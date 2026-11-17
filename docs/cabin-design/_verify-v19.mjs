import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v19.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v19');
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
assert(await page.locator('#charImg').evaluate(el => el.naturalWidth > 0 && el.src.includes('pose-idle')), 'transparent pose sprite loaded');
assert(await page.locator('#console').isVisible(), 'TUI console visible right of character');
const geo = await page.evaluate(() => { const c = document.getElementById('character').getBoundingClientRect(); const k = document.getElementById('console').getBoundingClientRect(); return { charRight: c.right, conLeft: k.left, conTop: k.top, conH: k.height }; });
assert(geo.conLeft >= geo.charRight - 4, 'console sits to the right of character');
assert(geo.conH > 400, 'console tall (fills right area)');
assert(await page.evaluate(() => getComputedStyle(document.getElementById('console')).backdropFilter.includes('blur')), 'console glass backdrop-filter');
assert(await page.locator('.rhex').count() === 5, '5 hex menus incl warp');
assert(await page.locator('#dotOps').textContent().then(t => t === '3'), 'ops dot 3');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow desktop');

// warp travel -> scene switch
const s0 = await page.locator('#sceneName').textContent();
await page.click('#rWarp'); await wait(1300);
const s1 = await page.locator('#sceneName').textContent();
assert(s0 !== s1, 'warp changes scene (' + s0 + ' -> ' + s1 + ')');
assert(await page.locator('.sdot.on').evaluate(el => el.dataset.scene === '1'), 'scene dot 1 active');
await shot('02-cruise');
await page.click('#rWarp'); await wait(1300);
assert(await page.locator('#sceneName').textContent().then(t => t.includes('星云')), 'second warp -> nebula');
await shot('03-nebula');
await page.click('.sdot[data-scene="0"]'); await wait(1200);
assert(await page.locator('#sceneName').textContent().then(t => t.includes('舰桥')), 'scene dot returns to bridge');

// pose swap on mood (resolve -> happy)
await page.click('#rOps'); await wait(500);
await page.click('.ocard[data-op="op-m2"]'); await wait(600);
assert(await page.locator('#conChoices').isVisible(), 'choices in console');
const poseBefore = await page.locator('#charImg').evaluate(el => el.src);
await page.click('.vchoice[data-label="验收通过"]'); await wait(1200);
assert(await page.locator('#fPose').textContent().then(t => t === 'happy'), 'pose swaps to happy on resolve');
assert(await page.locator('#charImg').evaluate(el => el.src.includes('pose-happy')), 'happy sprite actually swapped in');
assert(await page.locator('#dotOps').textContent().then(t => t === '2'), 'ops dot decremented');
await shot('04-resolved-happy');

// command spawn
await page.click('#conBack'); await wait(400);
await page.fill('#cmdInput', '帮我新建一个对账差异告警的开发任务');
await page.click('#btnSend'); await wait(1300);
assert(await page.locator('#conLog .tl').count() >= 4, 'command + reply in TUI log');
await shot('05-command');

// detail tabs
await page.click('#rDetail'); await wait(500);
assert(await page.locator('.dtab').count() === 4, 'detail tabs');
await page.click('[data-dtab="changes"]'); await wait(300);
assert(await page.locator('.file').count() >= 1, 'changes diff');
await page.click('[data-close]'); await wait(300);

// full log expand
const hB = await page.locator('#console').evaluate(el => el.getBoundingClientRect().height);
await page.click('#conFull'); await wait(500);
const hA = await page.locator('#console').evaluate(el => el.getBoundingClientRect().height);
assert(hA > hB + 40, 'full log expands console');
await page.click('#conFull'); await wait(400);

// arrival banner -> thread
await page.click('#btnSim'); await wait(900);
assert(await page.locator('#banner').evaluate(el => el.classList.contains('show')), 'banner shown');
await page.click('#banner'); await wait(600);
assert(await page.locator('#conChoices').isVisible(), 'banner opens thread choices');
const opsBefore = +(await page.locator('#dotOps').textContent());
await page.keyboard.press('1'); await wait(900);
const opsAfter = +(await page.locator('#dotOps').textContent());
assert(opsAfter === opsBefore - 1, 'keyboard resolve decrements (' + opsBefore + '->' + opsAfter + ')');

// log panel + sound + theme
await page.click('#lLog'); await wait(400);
assert(await page.locator('.loglm').count() >= 3, 'log panel');
await page.click('[data-close]'); await wait(300);
await page.click('#btnSound'); await wait(150);
assert(await page.locator('#btnSound').evaluate(el => el.classList.contains('off')), 'sound off');
await page.click('#btnSound'); await wait(150);
await page.click('#btnTheme'); await wait(250);
await shot('06-theme');
await page.click('#btnTheme'); await page.click('#btnTheme'); await wait(200);

// stability repeated warp + toggle
for (let i = 0; i < 3; i++) { await page.click('#rWarp'); await wait(300); }
await wait(800);
assert(await page.locator('.rhex').count() === 5, 'hub intact after repeated warp');
await shot('07-final');

// mobile
await page.setViewportSize({ width: 390, height: 844 }); await wait(800);
await shot('08-mobile');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow mobile');
const mg = await page.evaluate(() => { const k = document.getElementById('console').getBoundingClientRect(); const c = document.getElementById('character').getBoundingClientRect(); return { conTop: k.top, conBot: k.bottom, charBot: c.bottom }; });
assert(mg.conBot <= 844, 'console within mobile viewport');
assert(mg.charBot <= mg.conTop + 30, 'character stands above console on mobile');
await page.click('#rCmd'); await wait(400);
const ib = await page.locator('#conIn').boundingBox();
assert(ib && ib.y + ib.height <= 844, 'input within mobile viewport');
await page.fill('#cmdInput', '移动端回应'); await page.click('#btnSend'); await wait(900);
assert(await page.locator('#conLog .tl').count() >= 4, 'mobile send works');
await shot('09-mobile-console');

// tablet
await page.setViewportSize({ width: 1024, height: 768 }); await wait(700);
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow tablet');
await shot('10-tablet');

await browser.close();
log('\n=== ERRORS (' + errors.length + ') ===');
errors.forEach(e => log(' -', e));
process.exit(errors.length ? 1 : 0);