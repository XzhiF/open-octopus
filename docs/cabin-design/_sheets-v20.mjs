import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.png': 'image/png', '.html': 'text/html', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise(r => server.listen(8125, r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8125/cockpit-v20.html');
await page.waitForTimeout(400);
const names = ['idle', 'working', 'alert', 'happy', 'thinking', 'worried', 'cheer', 'wink', 'sleep', 'salute', 'command', 'typing'];
const out = await page.evaluate(async (names) => {
  const res = {};
  const load = src => new Promise(resolve => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = src; });
  const key = img => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2]; const gn = g - Math.max(r, b);
      if (gn > 40 && g > 90) p[i + 3] = 0;
      else if (gn > 10 && g > 70) { const a = clamp(1 - (gn - 10) / 30, 0, 1); p[i + 3] = Math.round(p[i + 3] * a); p[i + 1] = Math.max(r, b); }
    }
    x.putImageData(d, 0, 0); return c;
  };
  for (const n of names) {
    const alt = await load('./assets/raw-v20/alt-' + n + '.png');
    const a = await load('./assets/pose-' + n + '.png');
    if (!alt || !a) { res[n] = null; continue; }
    const keyed = key(alt);
    res['alt-' + n] = keyed.toDataURL('image/png');
    const W = 640, FH = 960;
    const s = document.createElement('canvas'); s.width = W; s.height = FH * 2;
    const sx = s.getContext('2d');
    sx.drawImage(a, 0, 0, W, FH);
    sx.drawImage(keyed, 0, FH, W, FH);
    res['sheet-' + n] = s.toDataURL('image/png');
  }
  return res;
}, names);
for (const n of names) {
  for (const pre of ['alt-', 'sheet-']) {
    const url = out[pre + n];
    if (!url) { console.log('FAIL', pre + n); continue; }
    fs.writeFileSync(path.join(__dirname, 'assets', pre + n + '.png'), Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote assets/' + pre + n + '.png');
  }
}
await browser.close(); server.close();