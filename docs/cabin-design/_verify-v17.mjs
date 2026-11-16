import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v17.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v17');
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

await page.goto(file); await wait(1400);
await shot('01-initial');
assert(await page.locator('#character').isVisible(), 'character portrait visible');
assert(await page.locator('#vn').isVisible(), 'VN dialogue box visible');
const vnH = await page.locator('#vn').evaluate(el => el.getBoundingClientRect().height);
assert(vnH > 300, 'VN box grand height (' + Math.round(vnH) + 'px)');
assert(await page.locator('#vnLog .lm').count() >= 3, 'history visible in VN log');
assert((await page.locator('#curLine').textContent()).length > 5, 'current typewriter line present');
assert(await page.locator('#cmdInput').isVisible(), 'reply input integrated in VN');
assert(await page.locator('.fcard').count() === 9, 'fleet roster left');
assert(await page.locator('.acard').count() === 3, 'decision queue right');
assert(!(await page.locator('#detail').evaluate(el => el.classList.contains('open'))), 'detail closed initially');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow desktop');

// left fleet -> detail face + thread (Q1 restoration)
await page.click('.fcard[data-job="j-m2"]'); await wait(700);
assert(await page.locator('#detail').evaluate(el => el.classList.contains('open')), 'detail face opens from fleet');
assert(await page.locator('.dtab').count() === 4, 'detail has 4 tabs');
assert(await page.locator('#vnThread').textContent().then(t => t.includes('结算')), 'thread switched to job');
assert(await page.locator('#character').evaluate(el => el.classList.contains('dim')), 'character dims behind detail');
await shot('02-detail-overview');
await page.click('[data-dtab="changes"]'); await wait(400);
assert(await page.locator('.file').count() >= 1, 'changes tab shows diff files');
await shot('03-detail-changes');
await page.click('[data-dtab="accept"]'); await wait(400);
assert(await page.locator('.ac').count() >= 4, 'accept tab shows AC list');
await page.click('#dClose'); await wait(400);
assert(!(await page.locator('#detail').evaluate(el => el.classList.contains('open'))), 'detail closes');

// right decision -> in-place galgame choices -> resolve
await page.click('.acard[data-op="op-gw"]'); await wait(700);
assert(await page.locator('#vnChoices').isVisible(), 'galgame choice buttons appear');
assert(await page.locator('.vchoice').count() === 3, '3 choices for 限流');
await shot('04-choices');
await page.click('.vchoice[data-label="900 rps"]'); await wait(900);
assert(await page.locator('.acard[data-op="op-gw"]').count() === 0, 'op resolved & removed');
assert(await page.locator('#opsCount').textContent().then(t => t === '2'), 'queue decremented');
await shot('05-resolved');

// VN full log expand
const hBefore = await page.locator('#vn').evaluate(el => el.getBoundingClientRect().height);
await page.click('#vnFull'); await wait(600);
const hAfter = await page.locator('#vn').evaluate(el => el.getBoundingClientRect().height);
assert(hAfter > hBefore + 100, 'full log expands VN height (' + Math.round(hBefore) + '->' + Math.round(hAfter) + ')');
await shot('06-fulllog');
await page.click('#vnFull'); await wait(500);

// back to main + send command spawn
await page.click('#vnBack'); await wait(400);
await page.fill('#cmdInput', '帮我新建一个对账差异告警的开发任务');
await page.click('#btnSend'); await wait(1300);
assert(await page.locator('#vnLog .lm.me').count() >= 1, 'my message in log');
assert(await page.locator('.fcard').count() >= 10, 'new job spawned');
await shot('07-command');

// arrival brief -> in-place
await page.click('#btnSim'); await wait(900);
assert(await page.locator('#brief').evaluate(el => el.classList.contains('show')), 'brief shown');
await shot('08-brief');
await page.click('#brief'); await wait(700);
assert(await page.locator('#vnChoices').isVisible(), 'brief opens thread with choices');

// keyboard number resolve
await page.keyboard.press('1'); await wait(900);
assert(await page.locator('#opsCount').textContent().then(t => t === '2'), 'keyboard 1 resolved arrival op (3->2)');

// sound + theme
await page.click('#btnSound'); await wait(150);
assert(await page.locator('#soundLbl').textContent().then(t => t === '音效关'), 'sound off');
await page.click('#btnSound'); await wait(150);
await page.click('#btnTheme'); await wait(250);
assert(await page.evaluate(() => document.body.dataset.theme) === 'crimson', 'theme cycled');
await page.click('#btnTheme'); await page.click('#btnTheme'); await wait(200);

// character click
await page.click('#character', { force: true }); await wait(500);
assert(await page.locator('#vnThread').textContent().then(t => t.includes('主对话')), 'character click returns to main');

// stability repeated
for (let i = 0; i < 4; i++) { await page.click('#vnFull'); await wait(200); await page.click('#vnFull'); await wait(200); }
assert(await page.locator('#vnLog .lm').count() >= 3, 'log intact after toggles');
await shot('09-desktop-final');

// mobile
await page.setViewportSize({ width: 390, height: 844 }); await wait(700);
await shot('10-mobile');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow mobile');
assert(await page.locator('#btnOpsM').isVisible(), 'ops drawer btn mobile');
await page.click('#btnOpsM'); await wait(500);
assert(await page.locator('#railRight').evaluate(el => el.classList.contains('open')), 'ops drawer opens');
await shot('11-mobile-ops');
await page.click('#scrim', { position: { x: 30, y: 400 } }); await wait(400);
await page.click('#btnRailM'); await wait(500);
assert(await page.locator('#railLeft').evaluate(el => el.classList.contains('open')), 'fleet drawer opens');
await page.click('.fcard[data-job="j-m1"]'); await wait(600);
assert(await page.locator('#detail').evaluate(el => el.classList.contains('open')), 'detail opens mobile');
await shot('12-mobile-detail');
const cinBox = await page.locator('#vnIn').boundingBox();
assert(cinBox && cinBox.y + cinBox.height <= 844, 'VN input within mobile viewport');
await page.fill('#cmdInput', '移动端回应'); await page.click('#btnSend'); await wait(900);
assert(await page.locator('#vnLog .lm.me').count() >= 1, 'mobile send works');

// tablet
await page.setViewportSize({ width: 1024, height: 768 }); await wait(600);
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow tablet');
await shot('13-tablet');

await browser.close();
log('\n=== ERRORS (' + errors.length + ') ===');
errors.forEach(e => log(' -', e));
process.exit(errors.length ? 1 : 0);