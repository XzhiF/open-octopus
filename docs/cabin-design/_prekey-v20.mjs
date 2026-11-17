import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.png': 'image/png', '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise(r => server.listen(8124, r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8124/cockpit-v20.html');
await page.waitForTimeout(400);
const names = ['thinking', 'worried', 'cheer', 'wink', 'sleep', 'salute', 'command', 'typing'];
const out = await page.evaluate(async (names) => {
  const res = {};
  for (const n of names) {
    const src = './assets/raw-v20/pose-' + n + '.png';
    const url = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        for (let i = 0; i < p.length; i += 4) {
          const r = p[i], g = p[i + 1], b = p[i + 2]; const gn = g - Math.max(r, b);
          if (gn > 40 && g > 90) p[i + 3] = 0;
          else if (gn > 10 && g > 70) { const a = clamp(1 - (gn - 10) / 30, 0, 1); p[i + 3] = Math.round(p[i + 3] * a); p[i + 1] = Math.max(r, b); }
        }
        x.putImageData(d, 0, 0); resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
    res[n] = url;
  }
  return res;
}, names);
for (const n of names) {
  if (!out[n]) { console.log('FAIL key', n); continue; }
  fs.writeFileSync(path.join(__dirname, 'assets', 'pose-' + n + '.png'), Buffer.from(out[n].split(',')[1], 'base64'));
  console.log('keyed ->', 'assets/pose-' + n + '.png');
}
await browser.close(); server.close();