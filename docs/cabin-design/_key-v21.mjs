import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const NAMES = process.argv.slice(2).length ? process.argv.slice(2)
  : ['idle', 'working', 'alert', 'smile', 'thinking', 'concerned', 'cheer', 'wink', 'sleep', 'ready', 'typing'];
const MIME = { '.png': 'image/png' };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/_blank')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>key</title>'); return; }
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  fs.readFile(path.join(ROOT, rel), (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(d);
  });
});
await new Promise(r => server.listen(8128, r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8128/_blank');
const out = await page.evaluate(async (names) => {
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
  const res = {};
  for (const n of names) {
    const img = await load('./docs/cabin-design/assets/raw-v21/pose-' + n + '.png');
    if (!img) { res[n] = null; continue; }
    const keyed = key(img);
    res[n] = keyed.toDataURL('image/png');
  }
  return res;
}, NAMES);
for (const n of NAMES) {
  const url = out[n];
  if (!url) { console.log('FAIL', n); continue; }
  fs.writeFileSync(path.join(__dirname, 'assets', 'pose-' + n + '.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote assets/pose-' + n + '.png');
}
await browser.close(); server.close();
