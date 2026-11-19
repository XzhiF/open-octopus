// cockpit-v22 验证：纯视频立绘 · 13 段动作顺序轮播
//
// 覆盖面：
//   1) 四档视口启动即播第 1 支（01-wink），无 console 错误
//   2) 点立绘 13 次按 CLIPS 顺序 01→13 再回到 01；每支 readyState/opacity/currentSrc 对上
//   3) 13 支视频画布统一 768×1152，且画面里的人物高 / 脚底 / 中轴在容差内（人物比例一致）
//   4) 动作视频图鉴：13 张卡、旧/新角标、悬停起播、点击跳段
//   5) 截图落 shots-v22/（本地产物）
//
// 跑：cd docs/cabin-design && node _verify-v22.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8171;
const SHOTS = path.join(__dirname, 'shots-v22');
const MIME = { '.png': 'image/png', '.html': 'text/html', '.mjs': 'text/javascript', '.webm': 'video/webm' };
fs.mkdirSync(SHOTS, { recursive: true });

const server = http.createServer((req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' });
    res.end(d);
  });
});
await new Promise(r => server.listen(PORT, r));

const N = 13;
let fails = 0;
const ok = (cond, label, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  · ' + detail : ''}`); if (!cond) fails++; };

const browser = await chromium.launch();
const open = async (w, h) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/cockpit-v22.html`);
  await page.waitForTimeout(1800);
  return { page, errs };
};
const snap = page => page.evaluate(() => {
  const v = document.querySelector('#charVid');
  return { clip: state.clip, pose: state.pose, tag: document.querySelector('#poseTag').textContent,
    src: (v.currentSrc || v.src).split('/').pop(), op: getComputedStyle(v).opacity,
    live: document.querySelector('#character').classList.contains('live'), paused: v.paused, rs: v.readyState, vw: v.videoWidth, vh: v.videoHeight };
});

// ── 1) 四档视口启动即播 ──
for (const [w, h] of [[1600, 1000], [1200, 900], [900, 700], [560, 900]]) {
  const { page, errs } = await open(w, h);
  const s = await snap(page);
  ok(s.clip === 0 && s.src === '01-wink.webm' && s.op === '1' && s.live && !s.paused, `${w}×${h} 启动即播第 1 支`, JSON.stringify(s));
  ok(errs.length === 0, `${w}×${h} 无 console 错误`, errs.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, `v22-${w}.png`) });
  await page.close();
}

// ── 2) 点击 13 次顺序轮播 ──
{
  const { page, errs } = await open(1600, 1000);
  const seq = [await snap(page)];
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => document.querySelector('#character').click());
    await page.waitForTimeout(650);
    seq.push(await snap(page));
  }
  const orderOk = seq.slice(0, N).every((s, i) => s.clip === i && s.src === `${String(i + 1).padStart(2, '0')}-${s.pose}.webm`);
  ok(orderOk, '点击按 01→13 顺序轮播', seq.slice(0, N).map(s => s.src).join(' '));
  const wrap = seq[N];
  ok(wrap.clip === 0 && wrap.src === '01-wink.webm', '第 13 次点击回到第 1 支', `${wrap.clip}/${wrap.src}`);
  ok(seq.slice(0, N).every(s => s.op === '1' && s.live && !s.paused && s.rs >= 2), '每支都真正在播（opacity/live/readyState）');
  ok(seq.every(s => s.vw === 768 && s.vh === 1152), '13 支画布统一 768×1152', [...new Set(seq.map(s => `${s.vw}×${s.vh}`))].join(','));
  ok(errs.length === 0, '轮播无 console 错误', errs.join(' | '));
  await page.close();
}

// ── 3) 人物比例一致（浏览器内按 alpha 量 bbox）──
{
  const { page, errs } = await open(1600, 1000);
  const boxes = await page.evaluate(async (N) => {
    const out = [];
    for (let i = 0; i < N; i++) {
      playClip(i, { fx: false });
      const v = document.querySelector('#charVid');
      await new Promise(r => { if (v.readyState >= 2) r(); else v.addEventListener('loadeddata', r, { once: true }); });
      v.pause(); v.currentTime = 1.5;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      const c = document.createElement('canvas'); c.width = 768; c.height = 1152;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 0);
      const d = x.getImageData(0, 0, 768, 1152).data;
      const A = (px, py) => d[(py * 768 + px) * 4 + 3];
      let minX = 768, minY = 1152, maxX = -1, maxY = -1;
      for (let py = 0; py < 1152; py++) for (let px = 0; px < 768; px++) {
        if (A(px, py) > 64) {
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
      }
      const y0 = Math.round(minY + (maxY - minY) * 0.35), y1 = Math.round(minY + (maxY - minY) * 0.60);
      let sum = 0, cnt = 0;
      for (let py = y0; py <= y1; py++) for (let px = minX; px <= maxX; px++) if (A(px, py) > 64) { sum += px; cnt++; }
      out.push({ h: maxY - minY + 1, bottom: maxY + 1, torso: cnt ? sum / cnt : 0 });
    }
    return out;
  }, N);
  const hs = boxes.map(b => b.h), bs = boxes.map(b => b.bottom), ts = boxes.map(b => b.torso);
  ok(Math.max(...hs) - Math.min(...hs) <= 12, '人物高一致（13 支极差 ≤ 12px）', `${Math.min(...hs)}–${Math.max(...hs)}`);
  ok(Math.max(...bs) - Math.min(...bs) <= 8, '脚底基线一致（极差 ≤ 8px）', `${Math.min(...bs)}–${Math.max(...bs)}`);
  ok(Math.max(...ts) - Math.min(...ts) <= 12, '躯干中轴一致（极差 ≤ 12px，瞬时抬手会略微影响）', `${Math.min(...ts).toFixed(1)}–${Math.max(...ts).toFixed(1)}`);
  ok(errs.length === 0, '比例测量无 console 错误', errs.join(' | '));
  await page.close();
}

// ── 4) 图鉴 ──
{
  const { page, errs } = await open(1600, 1000);
  await page.evaluate(() => openPanel('poses'));
  await page.waitForTimeout(500);
  const g = await page.evaluate(() => ({
    title: document.querySelector('.pt span')?.textContent,
    cards: document.querySelectorAll('.posecard').length,
    marks: [...document.querySelectorAll('.posecard .mk')].map(x => x.textContent),
  }));
  ok(g.title === 'CLIP GALLERY · 13', '图鉴标题 13', g.title);
  ok(g.cards === 13, '13 张片段卡', String(g.cards));
  ok(g.marks[0] === '01 · 旧' && g.marks[12] === '13 · 新', '旧/新角标', g.marks.join(' | '));
  await page.locator('.posecard').nth(2).hover();
  await page.waitForTimeout(900);
  const hov = await page.evaluate(() => { const c = document.querySelectorAll('.posecard')[2], v = c.querySelector('.cv'); return { on: c.classList.contains('vidon'), paused: v.paused, rs: v.readyState }; });
  ok(hov.on && !hov.paused && hov.rs >= 2, '悬停卡片起播预览', JSON.stringify(hov));
  await page.evaluate(() => document.querySelectorAll('.posecard')[4].click());
  await page.waitForTimeout(800);
  const jumped = await snap(page);
  ok(jumped.clip === 4 && jumped.src === '05-concerned.webm', '点击卡片跳到该段', `${jumped.clip}/${jumped.src}`);
  await page.screenshot({ path: path.join(SHOTS, 'gallery-13clips.png') });
  ok(errs.length === 0, '图鉴无 console 错误', errs.join(' | '));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${fails ? 'FAIL' : 'PASS'} · ${fails} 项失败`);
process.exit(fails ? 1 : 0);
