import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v18.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v18');
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

await page.goto(file); await wait(1500);
await shot('01-hub');
assert(await page.locator('.scene img').evaluate(el => el.naturalWidth > 0), 'bridge scene image loaded');
assert(await page.locator('#rCmd').isVisible(), 'big command hex visible');
assert(await page.locator('.rhex').count() === 4, '4 right hex menus');
assert(await page.locator('.litem').count() === 4, '4 left system icons');
assert(await page.locator('#dotOps').textContent().then(t => t === '3'), 'ops red dot = 3');
assert(await page.evaluate(() => { const d = document.getElementById('dotOps'); const r = d.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === d || d.contains(el); }), 'ops red dot not clipped by hex');
assert(await page.locator('#commsbar').isVisible(), 'comms bar bottom-left');
assert(await page.locator('#clockwidget, .clockwidget').first().isVisible(), 'clock widget bottom-right');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow desktop');

// VN open via command hex
await page.click('#rCmd'); await wait(700);
assert(await page.locator('#vn').evaluate(el => el.classList.contains('open')), 'VN opens');
assert(await page.locator('#app').evaluate(el => el.classList.contains('talking')), 'hub hides when talking');
assert(await page.locator('#cmdInput').isVisible(), 'VN input visible');
assert((await page.locator('#curLine').textContent()).length > 5, 'typewriter current line');
await shot('02-vn');
await page.fill('#cmdInput', '帮我新建一个对账差异告警的开发任务');
await page.click('#btnSend'); await wait(1300);
assert(await page.locator('#vnLog .lm.me').count() >= 1, 'my command in VN log');
await page.keyboard.press('Escape'); await wait(500);
assert(!(await page.locator('#vn').evaluate(el => el.classList.contains('open'))), 'Esc closes VN, hub returns');
assert(await page.locator('#rCmd').isVisible(), 'hex menus back');

// fleet panel -> detail -> tabs -> talk
await page.click('#rFleet'); await wait(500);
assert(await page.locator('#panel').evaluate(el => el.classList.contains('open')), 'fleet panel opens');
assert(await page.locator('.frow').count() >= 9, 'fleet rows');
await shot('03-fleet-panel');
await page.click('.frow[data-job="j-m2"]'); await wait(500);
assert(await page.locator('.dtab').count() === 4, 'detail tabs');
await page.click('[data-dtab="changes"]'); await wait(300);
assert(await page.locator('.file').count() >= 1, 'changes diff');
await page.click('[data-dtab="accept"]'); await wait(300);
assert(await page.locator('.ac').count() >= 4, 'AC list');
await shot('04-detail');
await page.click('[data-talk="j-m2"]'); await wait(600);
assert(await page.locator('#vn').evaluate(el => el.classList.contains('open')), 'talk opens VN on job');
assert(await page.locator('#vnChoices').isVisible(), 'choices for j-m2');
await page.keyboard.press('Escape'); await wait(400);

// ops panel -> in-place choice resolve
await page.click('#rOps'); await wait(500);
assert(await page.locator('.ocard').count() === 3, 'ops cards');
await shot('05-ops-panel');
await page.click('.ocard[data-op="op-gw"]'); await wait(600);
assert(await page.locator('#vnChoices').isVisible(), 'VN choices from ops');
await page.click('.vchoice[data-label="900 rps"]'); await wait(900);
assert(await page.locator('#dotOps').textContent().then(t => t === '2'), 'ops dot decremented to 2');
await shot('06-resolved');
await page.keyboard.press('Escape'); await wait(400);

// arrival banner -> in-place
await page.click('#btnSim'); await wait(900);
assert(await page.locator('#banner').evaluate(el => el.classList.contains('show')), 'banner shown');
await shot('07-banner');
await page.click('#banner'); await wait(600);
assert(await page.locator('#vnChoices').isVisible(), 'banner opens VN choices');
await page.keyboard.press('1'); await wait(900);
assert(await page.locator('#dotOps').textContent().then(t => t === '2'), 'keyboard resolved arrival (3->2)');
await page.keyboard.press('Escape'); await wait(300);

// log panel
await page.click('#lLog'); await wait(500);
assert(await page.locator('.loglm').count() >= 3, 'log panel messages');
await page.click('[data-close]'); await wait(300);

// sound + theme
await page.click('#btnSound'); await wait(150);
assert(await page.locator('#btnSound').evaluate(el => el.classList.contains('off')), 'sound off state');
await page.click('#btnSound'); await wait(150);
await page.click('#btnTheme'); await wait(250);
await shot('08-theme');
await page.click('#btnTheme'); await page.click('#btnTheme'); await wait(200);

// stability
for (let i = 0; i < 4; i++) { await page.click('#rCmd'); await wait(200); await page.keyboard.press('Escape'); await wait(200); }
assert(await page.locator('.rhex').count() === 4, 'hub intact after toggles');
await shot('09-final');

// mobile
await page.setViewportSize({ width: 390, height: 844 }); await wait(700);
await shot('10-mobile-hub');
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow mobile');
assert(await page.locator('#rCmd').isVisible(), 'command hex mobile');
await page.click('#rOps'); await wait(500);
assert(await page.locator('#panel').evaluate(el => el.classList.contains('open')), 'ops panel mobile sheet');
await shot('11-mobile-panel');
await page.click('[data-close]'); await wait(300);
await page.click('#rCmd'); await wait(500);
const box = await page.locator('#vnIn').boundingBox();
assert(box && box.y + box.height <= 844, 'VN input within mobile viewport');
await page.fill('#cmdInput', '移动端回应'); await page.click('#btnSend'); await wait(900);
assert(await page.locator('#vnLog .lm.me').count() >= 1, 'mobile send works');
await shot('12-mobile-vn');

// tablet
await page.setViewportSize({ width: 1024, height: 768 }); await wait(600);
assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'no h-overflow tablet');
await shot('13-tablet');

await browser.close();
log('\n=== ERRORS (' + errors.length + ') ===');
errors.forEach(e => log(' -', e));
process.exit(errors.length ? 1 : 0);