import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
// 输入 assets/motion-<pose>.mp4 由视频模型以绿幕立绘为首帧生成（不入库）；
// 产出 assets/motion-sheet-<pose>.png（入库，运行时真源）与 assets/gifs/*.gif（入库预览）。
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.png': 'image/png', '.html': 'text/html', '.mjs': 'text/javascript', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' }); res.end(d); });
});
await new Promise(r => server.listen(8126, r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8126/cockpit-v20.html');
await page.waitForTimeout(400);
const NAMES = process.argv.slice(2).length ? process.argv.slice(2) : ['idle', 'working', 'alert', 'happy', 'thinking', 'worried', 'cheer', 'wink', 'sleep', 'salute', 'command', 'typing'];
const HERO = ['idle', 'typing', 'cheer', 'command'];
const out = await page.evaluate(async ({ NAMES, HERO }) => {
  const res = {};
  const loadImg = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
  const keyCanvas = c => {
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    let minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2]; const gn = g - Math.max(r, b);
      if (gn > 40 && g > 90) p[i + 3] = 0;
      else if (gn > 10 && g > 70) { const a = clamp(1 - (gn - 10) / 30, 0, 1); p[i + 3] = Math.round(p[i + 3] * a); p[i + 1] = Math.max(r, b); }
      if (p[i + 3] > 24) { const px = (i / 4) % c.width, py = Math.floor((i / 4) / c.width); if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
    }
    x.putImageData(d, 0, 0);
    return { minx, miny, maxx, maxy };
  };
  const seek = (v, t) => new Promise(r => { const h = () => { v.removeEventListener('seeked', h); setTimeout(r, 30); }; v.addEventListener('seeked', h); v.currentTime = t; });
  const FW = 480, FH = 720, N = 12;
  const scene = await loadImg('./assets/scene-bridge.png');
  for (const n of NAMES) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = './assets/motion-' + n + '.mp4';
    const ok = await new Promise(r => { v.addEventListener('loadeddata', () => r(true), { once: true }); v.addEventListener('error', () => r(false), { once: true }); });
    if (!ok) { res[n] = null; continue; }
    const dur = v.duration || 5;
    const t0 = dur * 0.3, span = Math.min(1.15, dur * 0.45);
    const keyed = []; let U = { minx: 1e9, miny: 1e9, maxx: -1, maxy: -1 };
    for (let i = 0; i < N; i++) {
      await seek(v, t0 + span * i / (N - 1));
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      const bb = keyCanvas(c);
      U = { minx: Math.min(U.minx, bb.minx), miny: Math.min(U.miny, bb.miny), maxx: Math.max(U.maxx, bb.maxx), maxy: Math.max(U.maxy, bb.maxy) };
      keyed.push(c);
    }
    if (U.maxx < 0) { res[n] = null; continue; }
    const pad = 6;
    U.minx = Math.max(0, U.minx - pad); U.miny = Math.max(0, U.miny - pad);
    U.maxx = Math.min(keyed[0].width - 1, U.maxx + pad); U.maxy = Math.min(keyed[0].height - 1, U.maxy + pad);
    const bw = U.maxx - U.minx + 1, bh = U.maxy - U.miny + 1;
    const sc = Math.min(FW / bw, FH / bh);
    const dw = Math.round(bw * sc), dh = Math.round(bh * sc);
    const dx = Math.round((FW - dw) / 2), dy = FH - dh;
    const sheet = document.createElement('canvas'); sheet.width = FW; sheet.height = FH * N;
    const sx = sheet.getContext('2d');
    const comp = [];
    for (let i = 0; i < N; i++) {
      sx.drawImage(keyed[i], U.minx, U.miny, bw, bh, dx, i * FH + dy, dw, dh);
      if (HERO.includes(n) && scene) {
        const g = document.createElement('canvas'); g.width = FW; g.height = FH;
        const gx = g.getContext('2d');
        gx.drawImage(scene, 0, Math.round(scene.height * 0.12), Math.round(scene.width * 0.40), Math.round(scene.height * 0.88), 0, 0, FW, FH);
        gx.drawImage(keyed[i], U.minx, U.miny, bw, bh, dx, dy, dw, dh);
        comp.push(g.toDataURL('image/png'));
      }
    }
    res[n] = { sheet: sheet.toDataURL('image/png'), comp };
    v.src = ''; v.load();
  }
  return res;
}, { NAMES, HERO });
for (const n of NAMES) {
  if (!out[n]) { console.log('FAIL motion', n); continue; }
  fs.writeFileSync(path.join(__dirname, 'assets', 'motion-sheet-' + n + '.png'), Buffer.from(out[n].sheet.split(',')[1], 'base64'));
  console.log('sheet -> assets/motion-sheet-' + n + '.png');
  if (out[n].comp && out[n].comp.length) {
    const dir = path.join(__dirname, 'assets', 'gifframes-' + n);
    fs.mkdirSync(dir, { recursive: true });
    const order = [...out[n].comp, ...out[n].comp.slice(1, -1).reverse()];
    order.forEach((d, i) => fs.writeFileSync(path.join(dir, 'f' + String(i).padStart(2, '0') + '.png'), Buffer.from(d.split(',')[1], 'base64')));
    const gif = path.join(__dirname, 'assets', 'gifs', 'xiyin-motion-' + n + '.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(dir, 'f%02d.png'), '-vf', 'palettegen=stats_mode=diff', path.join(dir, 'pal.png')]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '12', '-i', path.join(dir, 'f%02d.png'), '-i', path.join(dir, 'pal.png'), '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', gif]);
    console.log('gif -> shots-v20/xiyin-motion-' + n + '.gif');
  }
}
await browser.close(); server.close();