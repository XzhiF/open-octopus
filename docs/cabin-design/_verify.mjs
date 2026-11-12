import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const shots = path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });
const errors = [];
const log = (...a) => console.log(...a);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
const shot = async n => { await page.screenshot({ path: path.join(shots, n + '.png') }); log('  📸', n); };
const wait = ms => page.waitForTimeout(ms);
// click latest unanswered ask: first option + submit
async function answerAsk(optIndex = 0) {
  const card = page.locator('.ask-card:not(.answered)').last();
  await card.locator('.opt').nth(optIndex).click();
  await wait(120);
  await card.locator('[data-action="ask-submit"]').click();
  await wait(300);
}
async function clickDecision(btnIndex = 0) {
  const card = page.locator('.card:not(.decided)').last();
  await card.locator('.cbtn').nth(btnIndex).click();
  await wait(300);
}
// dock modules beyond the primary set live in the left "更多" popover
const DOCK_OVERFLOW = ['repos', 'worktree', 'iterations', 'changes', 'acceptance', 'archive', 'tuning', 'gallery'];
async function dockMod(mod) {
  if (DOCK_OVERFLOW.includes(mod)) {
    if (!(await page.locator('.dock-more.open').count())) { await page.click('[data-action="dock-more"]'); await wait(220); }
    await page.click(`.dock-more-grid .dock-btn[data-mod="${mod}"]`);
  } else {
    await page.click(`.dock-btn[data-mod="${mod}"]`);
  }
  await wait(280);
}

try {
  await page.goto(file, { waitUntil: 'load' });
  await wait(400);
  log('▶ initial: sidebar tree + center chat + dock');
  const secs = await page.locator('.sec-label b').allTextContents();
  log('  sidebar sections:', secs.join(' / '));
  const dockBtns = await page.locator('.dock-btn').count();
  log('  dock buttons:', dockBtns);
  await shot('01-initial');
  const imgOk = await page.evaluate(() => { const im = document.querySelector('.xy-frame img'); return im ? im.naturalWidth : -1; });
  log('  汐音 portrait naturalWidth:', imgOk);

  // ── creation interview ──
  log('▶ new cabin (hero, optional note)');
  await page.click('[data-action="new-menu"]');
  await wait(150);
  await page.click('[data-action="new-cabin"]');
  await wait(250);
  await shot('02-hero');
  await page.click('[data-action="start-cabin"]');
  await wait(500);
  log('▶ init interview: directory ask');
  await shot('03-ask-dir');
  await answerAsk(0); // new dir
  log('▶ repos ask');
  await shot('04-ask-repos');
  await answerAsk(0); // infer
  log('▶ M1 decision');
  await shot('05-m1');
  await clickDecision(0); // launch
  log('▶ gate running');
  await wait(4500);
  await shot('06-init-done');
  const gateDone = await page.locator('.gi.done').count();
  log('  gate done:', gateDone, '/ 7');

  // ── reuse path (separate) ──
  log('▶ reuse path');
  await page.click('[data-action="new-menu"]'); await wait(120);
  await page.click('[data-action="new-cabin"]'); await wait(200);
  await page.click('[data-action="start-cabin"]'); await wait(450);
  await answerAsk(2); // 沿用 aurora
  await shot('07-reuse-decision');
  await clickDecision(0); // reuse
  await wait(400);
  await shot('08-reused');

  // ── dock windows (close-on-left) ──
  log('▶ dock windows');
  for (const mod of ['overview', 'worktree', 'tasks', 'changes', 'archive']) {
    await dockMod(mod);
  }
  const lights = await page.locator('.win.focused .light.close').count();
  log('  focused window close-light:', lights);
  await shot('09-windows');
  // drag focused window
  const bar = page.locator('.win.focused .win-bar');
  const bb = await bar.boundingBox();
  await page.mouse.move(bb.x + 200, bb.y + 18);
  await page.mouse.down(); await page.mouse.move(bb.x + 120, bb.y + 60, { steps: 5 }); await page.mouse.up();
  await wait(200);
  await shot('10-dragged');
  // close via left light
  await page.click('.win.focused .light.close'); await wait(200);

  // ── panes ──
  log('▶ files pane');
  await page.click('.dock-btn[data-mod="files"]'); await wait(250);
  await shot('11-files-pane');
  await page.click('.pane .close-light'); await wait(150);
  await page.click('.dock-btn[data-mod="activity"]'); await wait(250);
  await shot('12-activity-pane');
  await page.click('.pane .close-light'); await wait(150);

  // ── chat send + attention ──
  // clear floating windows so the composer is reachable (windows legitimately overlay chat)
  for (let i = 0; i < 10; i++) { const c = page.locator('.win.focused .light.close'); if (await c.count()) { await c.click(); await wait(120); } else break; }
  log('▶ chat send');
  await page.fill('#chatInput', '开始 M2 对账引擎，差异要可追溯');
  await page.click('[data-action="send"]');
  await wait(2600);
  await shot('13-chat-run');
  log('▶ attention → chat');
  await page.click('.dock-btn[data-mod="overview"]'); await wait(250);
  await page.click('.win.focused .attn'); await wait(500);
  await shot('14-attention');

  // ── comms queue + state flow (superagent 回流) ──
  log('▶ comms queue + state flow');
  await page.click('.dock-btn[data-mod="queue"]'); await wait(350);
  await shot('19-queue');
  const queuedBefore = await page.locator('.comm.queued').count();
  await page.click('.comm.queued [data-action="comm-process"]'); await wait(450);
  await shot('20-queue-processing');
  const proc1 = await page.locator('.comm.processing').count();
  await page.click('.comm.queued [data-action="comm-process"]'); await wait(250);
  const proc2 = await page.locator('.comm.processing').count();
  log('  single-thread processing:', proc1, '->', proc2, '(prioritize keeps 1)');
  await wait(1300);
  const doneAfter = await page.locator('.comm.done').count();
  log('  queued before:', queuedBefore, '· done after:', doneAfter);
  await shot('21-queue-done');
  await page.click('.win.focused .light.close'); await wait(200);
  // character states (image-based 汐音)
  await wait(2100);
  await page.locator('.xy-frame').screenshot({ path: path.join(shots, '22-xiyin-alert.png') });
  log('  📸 22-xiyin-alert');
  await page.click('.row[data-action="open-cabin"]:has-text("Hermes")'); await wait(500);
  await page.locator('.xy-frame').screenshot({ path: path.join(shots, '23-xiyin-sleep.png') });
  log('  📸 23-xiyin-sleep');
  await page.click('.row[data-action="open-cabin"]:has-text("Aurora")'); await wait(500);
  await page.evaluate(() => { const c = state.cabins.find(x => x.slug === 'aurora'); c._attn = c.attention; c.attention = []; state.crewOverride = null; renderCrew(); });
  await wait(400);
  await page.locator('.xy-frame').screenshot({ path: path.join(shots, '24-xiyin-working.png') });
  log('  📸 24-xiyin-working');
  await page.evaluate(() => { const c = state.cabins.find(x => x.slug === 'aurora'); c.attention = c._attn; renderCrew(); });
  await wait(200);

  // ── 汐音 assistant: game feedback + message prep + hub ──
  log('▶ 汐音 assistant feedback + hub');
  for (let i = 0; i < 10; i++) { const c = page.locator('.win.focused .light.close'); if (await c.count()) { await c.click(); await wait(100); } else break; }
  await page.click('.xy-frame'); await wait(700);
  log('  xy dialogue shown:', await page.locator('.xy-dialog.show').count(), '· buttons in dialogue:', await page.locator('.xy-dialog button').count());
  await shot('33-xiyin-dialog');
  await page.locator('.crew-pod').screenshot({ path: path.join(shots, '34-xiyin-pod.png') });
  log('  📸 34-xiyin-pod');
  await page.evaluate(() => { const c = state.cabins.find(x => x.slug === 'aurora'); const m = (c.comms || []).find(x => x.state === 'queued'); if (m) xyPrepare(m); });
  await wait(900);
  await shot('35-xiyin-prepare');
  await page.click('.xy-menu'); await wait(300);
  log('  hub open:', await page.locator('.crew-hub.open').count());
  await shot('36-xiyin-hub');
  await page.click('.crew-hub [data-action="hub-info"]'); await wait(200);
  await shot('37-xiyin-info');
  await page.click('.crew-hub [data-action="hub-open"][data-mod="missions"]'); await wait(350);
  await page.locator('.win[data-win="missions"] .taskpanel').screenshot({ path: path.join(shots, '31-mission.png') });
  log('  📸 31-mission');
  await page.click('.win.focused .light.close'); await wait(200);
  await page.click('.dock-btn[data-mod="queue"]'); await wait(300);
  await page.click('.comm.queued [data-action="comm-process"]'); await wait(1600);
  await shot('38-processed');
  await page.click('.win.focused .light.close'); await wait(200);

  // ── tuning window: live customization (on-demand) ──
  log('▶ tuning window customization');
  await dockMod('tuning'); await wait(120);
  log('  tuning sliders:', await page.locator('.tuning input[type=range]').count(), '· swatches:', await page.locator('.tuning .swatch').count());
  await shot('25-tuning-default');
  await page.click('.tuning .swatch[data-val="luna"]'); await wait(300);
  await shot('26-theme-luna');
  await page.click('.tuning .seg-btn[data-val="holo"]'); await wait(250);
  await page.evaluate(() => { const set = (k, v) => { const r = document.querySelector(`.tuning input[data-ck="${k}"]`); r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }; set('glow', '1.8'); set('particles', '44'); });
  await wait(300);
  await shot('27-holo-glow');
  await page.selectOption('.tuning select[data-ck="mood"]', 'happy'); await wait(500);
  await page.locator('.xy-frame').screenshot({ path: path.join(shots, '28-xiyin-happy.png') });
  log('  📸 28-xiyin-happy');
  await page.click('.tuning [data-helm="random"]'); await wait(350);
  await shot('29-random');
  await page.click('.tuning [data-helm="reset"]'); await wait(350);
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('.tuning [data-helm="export-json"]')]);
  log('  download:', dl1.suggestedFilename());
  await dl1.saveAs(path.join(shots, 'cabin-cockpit.json'));
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('.tuning [data-helm="export-portrait"]')]);
  log('  download:', dl2.suggestedFilename());
  const pngPath = path.join(shots, 'xiyin-export.jpg');
  await dl2.saveAs(pngPath);
  const p2 = await browser.newPage({ viewport: { width: 240, height: 300 } });
  const imgErrors = [];
  p2.on('pageerror', e => imgErrors.push(e.message));
  await p2.goto('file:///' + pngPath.replace(/\\/g, '/'), { waitUntil: 'load' });
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: path.join(shots, '32-export-portrait.png') });
  log('  📸 32-export-portrait · standalone errors:', imgErrors.length);
  await p2.close();
  await page.click('.win.focused .light.close'); await wait(200);
  await page.click('#soundBtn'); await wait(150);
  await page.click('#soundBtn'); await wait(150);
  await shot('30-after-reset');

  // ── 汐音立绘画廊 ──
  log('▶ gallery');
  await dockMod('gallery');
  log('  gallery cards:', await page.locator('.xy-card').count());
  await page.click('.xy-card[data-form="wink"]'); await wait(300);
  log('  picked state:', await page.evaluate(() => document.querySelector('#crewPod').dataset.state));
  await shot('39-gallery');
  await page.click('.win.focused .light.close'); await wait(200);

  // ── task thread + session ──
  log('▶ task thread');
  await page.click('.row[data-action="open-task-thread"]'); await wait(300);
  await shot('15-task-thread');
  await page.click('.row[data-action="open-session"]'); await wait(250);
  await shot('16-session');

  // ── mission control ──
  log('▶ mission control');
  await page.click('[data-action="mission"]'); await wait(250);
  await shot('17-mission');
  await page.keyboard.press('Escape'); await wait(200);

  // ── responsive ──
  log('▶ responsive 820');
  await page.setViewportSize({ width: 820, height: 900 });
  await wait(300);
  await shot('18-responsive');

} catch (e) {
  errors.push('script: ' + e.message);
  await shot('99-error').catch(() => {});
}
await browser.close();
log('\n════════ RESULT ════════');
if (errors.length) { log('❌ ERRORS (' + errors.length + '):'); errors.forEach(e => log('  -', e)); process.exit(1); }
else log('✅ No console/page errors. Full flow rendered.');