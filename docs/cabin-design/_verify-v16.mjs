import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'cockpit-v16.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots-v16');
fs.mkdirSync(shots, { recursive: true });
const errors = [];
const log = (...a) => console.log(...a);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async n => { await page.screenshot({ path: path.join(shots, n + '.png') }); log('  shot', n); };
const wait = ms => page.waitForTimeout(ms);
const assert = (cond, msg) => { if (!cond) { errors.push('ASSERT: ' + msg); log('  FAIL', msg); } else log('  ok', msg); };

await page.goto(file);
await wait(1200);
await shot('01-initial');

// initial: no input visible (requirement 1), core present, deck peek shows history
assert(await page.locator('#core').isVisible(), 'command core visible');
assert(!(await page.locator('#cin').isVisible()), 'no permanent bottom input (cin hidden in peek)');
assert(await page.locator('#flow .msg').count() >= 4, 'chat history visible in peek deck');
assert(await page.locator('.op').count() === 3, '3 pending ops seeded');
assert(await page.locator('#deck').evaluate(el => el.getBoundingClientRect().height > 150), 'deck has height');
assert(!(await page.locator('#deckBack').isVisible()), 'back button hidden on main peek');
assert(!(await page.locator('#deckClose').isVisible()), 'close button hidden on peek');
assert(!(await page.locator('#deckMeta').isVisible()), 'meta hidden on main');

// overflow check
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert(overflow <= 0, 'no horizontal overflow desktop');

// open console via core (requirement 2)
await page.click('#core');
await wait(600);
assert(await page.locator('#cin').isVisible(), 'input appears after core click');
assert(await page.locator('#deck').evaluate(el => el.classList.contains('active')), 'deck active');
assert(!(await page.locator('#deckExpand').isVisible()), 'expand hidden when active');
assert(await page.locator('#deckClose').isVisible(), 'close visible when active');
assert(await page.locator('#core').evaluate(el => el.classList.contains('compact')), 'core compact when active');
await shot('02-console-open');

// type + send command
await page.fill('#cmdInput', '帮我新建一个对账差异告警的开发任务');
await page.click('#btnSend');
await wait(1400);
assert(await page.locator('#flow .msg.me').count() >= 1, 'my command in flow');
const jobsAfter = await page.locator('.frow').count();
assert(jobsAfter >= 9, 'new job spawned into fleet (' + jobsAfter + ')');
await shot('03-command-sent');

// close via Esc
await page.keyboard.press('Escape');
await wait(500);
assert(!(await page.locator('#cin').isVisible()), 'Esc closes console, input hidden');

// pending op -> open thread + decision card + reply in place (requirement 3/5)
await page.click('.op[data-op="op-gw"]');
await wait(700);
assert(await page.locator('#deckTitle').textContent().then(t => t.includes('限流')), 'thread switched to 限流');
assert(await page.locator('[data-dcard="op-gw"]').isVisible(), 'decision card inline in thread');
assert(await page.locator('#cin').isVisible(), 'reply input present in thread');
await shot('04-thread-decision');

// answer via option 2 (900 rps)
await page.click('[data-dopt="op-gw"][data-label="900 rps"]');
await wait(900);
assert(await page.locator('.op[data-op="op-gw"]').count() === 0, 'op-gw removed from queue after answer');
assert(await page.locator('.dcard.answered').count() >= 1, 'answered receipt in thread');
assert(await page.locator('#opsCount').textContent().then(t => t === '2'), 'queue count decremented to 2');
await shot('05-answered');

// quick rec action on another op
await page.click('.op-rec[data-oprec="op-m1"]');
await wait(900);
assert(await page.locator('#opsCount').textContent().then(t => t === '1'), 'quick rec resolved op-m1, count 1');

// back to main
await page.click('#deckBack');
await wait(500);
assert(await page.locator('#deckTitle').textContent().then(t => t.includes('主对话')), 'back to main thread');

// simulate arrival -> brief -> click brief -> in-place reply (requirement 3)
await page.click('#btnSim');
await wait(900);
assert(await page.locator('#brief').evaluate(el => el.classList.contains('show')), 'brief shown on arrival');
await shot('06-arrival-brief');
await page.click('#brief');
await wait(700);
assert(await page.locator('#cin').isVisible(), 'clicking brief opens thread with reply input');
assert(await page.locator('[data-dcard]').count() >= 1, 'decision card present from brief');
await shot('07-brief-to-thread');

// keyboard number answer
await page.keyboard.press('Escape'); // close first
await wait(300);
await page.click('#btnCmd'); // reopen main
await wait(400);
await page.keyboard.press('Escape');
await wait(300);

// sound toggle
await page.click('#btnSound');
await wait(200);
assert(await page.locator('#soundLbl').textContent().then(t => t === '音效关'), 'sound toggled off');
await page.click('#btnSound');
await wait(200);
assert(await page.locator('#soundLbl').textContent().then(t => t === '音效开'), 'sound toggled on');

// theme cycle
await page.click('#btnTheme');
await wait(300);
assert(await page.evaluate(() => document.body.dataset.theme) === 'terminal', 'theme cycled');
await page.click('#btnTheme'); await page.click('#btnTheme'); await page.click('#btnTheme');
await wait(200);

// portrait click opens console
await page.click('#pod', { force: true });
await wait(600);
assert(await page.locator('#cin').isVisible(), 'portrait click opens console');
await page.keyboard.press('Escape');
await wait(300);

// repeated open/close stability
for (let i = 0; i < 4; i++) { await page.click('#core'); await wait(250); await page.keyboard.press('Escape'); await wait(250); }
assert(await page.locator('#flow .msg').count() >= 4, 'flow intact after repeated toggle');

await shot('08-desktop-final');

// ── mobile ──
await page.setViewportSize({ width: 390, height: 844 });
await wait(700);
await shot('09-mobile-initial');
const mOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert(mOverflow <= 0, 'no horizontal overflow mobile');
assert(await page.locator('#core').isVisible(), 'core visible mobile');
assert(await page.locator('#btnOpsM').isVisible(), 'ops drawer button visible mobile');
assert(await page.locator('#btnRailM').isVisible(), 'rail drawer button visible mobile');

// open ops drawer
await page.click('#btnOpsM');
await wait(500);
assert(await page.locator('#ops').evaluate(el => el.classList.contains('open')), 'ops drawer opens');
await shot('10-mobile-ops-drawer');
await page.click('#scrim', { position: { x: 30, y: 400 } });
await wait(400);

// open console mobile + send
await page.click('#core');
await wait(500);
assert(await page.locator('#cin').isVisible(), 'mobile console input visible');
const cinBox = await page.locator('#cin').boundingBox();
assert(cinBox && cinBox.y + cinBox.height <= 844, 'mobile input within viewport');
await shot('11-mobile-console');
await page.fill('#cmdInput', '移动端测试指令');
await page.click('#btnSend');
await wait(1000);
assert(await page.locator('#flow .msg.me').count() >= 1, 'mobile send works');
await page.keyboard.press('Escape');
await wait(300);

// rail drawer
await page.click('#btnRailM');
await wait(500);
assert(await page.locator('#rail').evaluate(el => el.classList.contains('open')), 'rail drawer opens');
await page.click('.frow[data-job="j-m2"]');
await wait(600);
assert(await page.locator('#deckTitle').textContent().then(t => t.includes('结算')), 'rail row opens thread mobile');
await shot('12-mobile-thread');

// tablet
await page.setViewportSize({ width: 1024, height: 768 });
await wait(600);
const tOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert(tOverflow <= 0, 'no horizontal overflow tablet');
await shot('13-tablet');

await browser.close();
log('\n=== ERRORS (' + errors.length + ') ===');
errors.forEach(e => log(' -', e));
process.exit(errors.length ? 1 : 0);