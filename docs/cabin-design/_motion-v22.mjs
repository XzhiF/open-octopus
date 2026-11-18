// v22 立绘 = 纯视频：用户指定的 13 支绿幕动作 mp4（旧批次 3 支 + 新批次 10 支），
// 离线抠像 → 高质量 VP9 alpha WebM（768×1152），全部按同一目标归一化后给 cockpit-v22.html 顺序轮播。
//
// 归一化（13 支同一个目标，所以人物比例/大小一致）：
//   输出画布 768×1152（2:3，和 .character 的 aspect-ratio 对齐）；
//   人物高（全片 alpha 并集）→ 1040px；脚底 → 1105px；躯干中轴 → 384px（画布中线）。
//
// 画质：源 720×1280/30fps，转 30fps 不丢帧；libvpx-vp9 CRF 24 + cpu-used 2，
//      显式写 bt709 / tv range，避免播放器做色彩矩阵猜测导致「颜色/对比度变了」。
//
// 依赖 ffmpeg（含 libvpx-vp9 / colorkey / despill）。
// 复跑：cd docs/cabin-design && node _motion-v22.mjs [序号|pose]
// 产物：assets/v22/<NN>-<pose>.webm（入库）+ assets/v22/thumbs/<NN>-<pose>.png（图鉴缩略图）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'assets', 'v22');
const THUMB_DIR = path.join(OUT_DIR, 'thumbs');

// 用户指定顺序（点击立绘按这个顺序轮播）
const CLIPS = [
  { out: '01-wink.webm',      src: '../../vibe_videos/motion-wink_1794850661.mp4',       pose: 'wink',      batch: '旧' },
  { out: '02-thinking.webm',  src: '../../vibe_videos/motion-thinking_1794850662.mp4',   pose: 'thinking',  batch: '旧' },
  { out: '03-command.webm',   src: '../../vibe_videos/motion-command_1794850802.mp4',    pose: 'command',   batch: '旧' },
  { out: '04-alert.webm',     src: '../../vibe_videos_2/motion-alert_1795016729.mp4',    pose: 'alert',     batch: '新' },
  { out: '05-concerned.webm', src: '../../vibe_videos_2/motion-concerned_1795016730.mp4',pose: 'concerned', batch: '新' },
  { out: '06-command.webm',   src: '../../vibe_videos_2/motion-command_1795016746.mp4',  pose: 'command',   batch: '新' },
  { out: '07-idle.webm',      src: '../../vibe_videos_2/motion-idle_1795016713.mp4',     pose: 'idle',      batch: '新' },
  { out: '08-ready.webm',     src: '../../vibe_videos_2/motion-ready_1795016746.mp4',    pose: 'ready',     batch: '新' },
  { out: '09-smile.webm',     src: '../../vibe_videos_2/motion-smile_1795016729.mp4',    pose: 'smile',     batch: '新' },
  { out: '10-thinking.webm',  src: '../../vibe_videos_2/motion-thinking_1795016716.mp4', pose: 'thinking',  batch: '新' },
  { out: '11-typing.webm',    src: '../../vibe_videos_2/motion-typing_1795016715.mp4',   pose: 'typing',    batch: '新' },
  { out: '12-wink.webm',      src: '../../vibe_videos_2/motion-wink_1795016744.mp4',     pose: 'wink',      batch: '新' },
  { out: '13-working.webm',   src: '../../vibe_videos_2/motion-working_1795016714.mp4',  pose: 'working',   batch: '新' },
];

const OW = 768, OH = 1152;          // 输出画布
const TARGET_H = 1040;              // 人物高（13 支统一）
const TARGET_BOTTOM = 1105;         // 脚底基线
const TARGET_X = 384;               // 躯干中轴 = 画布中线
const FPS = 30;                     // 源就是 30fps，不抽帧
const CRF = '24';
const ALPHA_THR = 64;

const ff = (args, opts = {}) => execFileSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 1 << 29, ...opts });
const alphaGray = (input, pre = []) =>
  ff(['-i', input, '-vf', [...pre, 'alphaextract', 'format=gray'].join(','), '-f', 'rawvideo', '-']);
const decodeAlpha = file =>
  ff(['-c:v', 'libvpx-vp9', '-i', file, '-vf', 'alphaextract,format=gray', '-f', 'rawvideo', '-']);

// 多帧统计：并集 bbox（用来裁掉大片透明边）+ 中位数身高/脚底/中轴（用来对齐，避免个别帧把基线拉偏）
function frameStats(buf, w, h, frames, thr = ALPHA_THR) {
  const fsz = w * h, n = Math.min(frames, Math.floor(buf.length / fsz));
  const rows = [];
  let ux0 = w, uy0 = h, ux1 = -1, uy1 = -1;
  for (let f = 0; f < n; f++) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const o = f * fsz + y * w;
      for (let x = 0; x < w; x++) {
        if (buf[o + x] > thr) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) continue;
    if (minX < ux0) ux0 = minX; if (minY < uy0) uy0 = minY;
    if (maxX > ux1) ux1 = maxX; if (maxY > uy1) uy1 = maxY;
    const bh = maxY - minY + 1;
    const y0 = Math.round(minY + bh * 0.35), y1 = Math.round(minY + bh * 0.60);
    let sum = 0, cnt = 0;
    for (let y = y0; y <= y1; y++) {
      const o = f * fsz + y * w;
      for (let x = minX; x <= maxX; x++) if (buf[o + x] > thr) { sum += x; cnt++; }
    }
    rows.push({ h: bh, bottom: maxY + 1, torsoX: cnt ? sum / cnt : (minX + maxX + 1) / 2 });
  }
  if (!rows.length) return null;
  const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return {
    h: med(rows.map(r => r.h)), bottom: med(rows.map(r => r.bottom)), torsoX: med(rows.map(r => r.torsoX)),
    ux: ux0, uy: uy0, uw: ux1 - ux0 + 1, uh: uy1 - uy0 + 1,
  };
}

const even = v => Math.max(2, Math.round(v / 2) * 2);

function keyColor(mp4) {
  const rgb = ff(['-i', mp4, '-vf', 'crop=2:2:4:4,scale=1:1:flags=area,format=rgb24', '-vframes', '1', '-f', 'rawvideo', '-']);
  return '0x' + rgb.toString('hex');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

const only = process.argv.slice(2);
for (const [i, clip] of CLIPS.entries()) {
  const idx = String(i + 1).padStart(2, '0');
  if (only.length && !only.includes(idx) && !only.includes(clip.pose)) continue;
  const src = path.resolve(__dirname, clip.src);
  if (!fs.existsSync(src)) { console.log(`SKIP ${clip.out}: 缺 ${src}`); continue; }

  const color = keyColor(src);
  const vmeta = frameStats(alphaGray(src, [`colorkey=${color}:0.22:0.08`, 'despill=type=green', 'fps=6']), 720, 1280, 30);
  if (!vmeta) { console.log(`SKIP ${clip.out}: 抠像后全透明`); continue; }

  // 裁到并集 bbox（留 12px 边），丢掉大片透明边；再按中位身高缩放
  const M = 12;
  const cx = even(Math.max(0, vmeta.ux - M)), cy = even(Math.max(0, vmeta.uy - M));
  const cw = even(Math.min(720 - cx, vmeta.uw + M * 2)), ch = even(Math.min(1280 - cy, vmeta.uh + M * 2));
  let k = TARGET_H / vmeta.h;
  // 保证缩放后的裁切框能放进 768×1152（pad 不允许输入大于画布）
  k = Math.min(k, (OW - 2) / cw, (OH - 2) / ch);
  const sw = even(cw * k), sh = even(ch * k);
  const kx = sw / cw, ky = sh / ch;
  const offX = Math.round(TARGET_X - (vmeta.torsoX - cx) * kx);
  const offY = Math.round(TARGET_BOTTOM - (vmeta.bottom - cy) * ky);
  if (offX < 0 || offY < 0 || offX + sw > OW || offY + sh > OH) {
    console.log(`WARN ${clip.out}: 归一化后越界 offX=${offX} offY=${offY} ${sw}x${sh}`);
  }

  const out = path.join(OUT_DIR, clip.out);
  ff([
    '-i', src, '-an',
    '-vf', [
      `colorkey=${color}:0.22:0.08`,
      'despill=type=green',
      `crop=${cw}:${ch}:${cx}:${cy}`,
      `scale=${sw}:${sh}:flags=lanczos`,
      `pad=${OW}:${OH}:${offX}:${offY}:color=0x00000000`,
      'format=yuva420p',
      `fps=${FPS}`,
    ].join(','),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-crf', CRF, '-b:v', '0', '-row-mt', '1', '-cpu-used', '2', '-g', String(FPS * 2),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    out, '-y',
  ]);

  // 图鉴缩略图：取 1.2s 一帧，带 alpha 缩到 320×480
  const thumb = path.join(THUMB_DIR, clip.out.replace(/\.webm$/, '.png'));
  ff(['-c:v', 'libvpx-vp9', '-ss', '1.2', '-i', out, '-vf', 'scale=320:480:flags=lanczos', '-vframes', '1', thumb, '-y']);

  const chk = frameStats(decodeAlpha(out), OW, OH, 150);
  const size = (fs.statSync(out).size / 1048576).toFixed(2);
  console.log(`OK  ${clip.out}  key=${color}  ${sw}x${sh}@${offX},${offY}  ${size}MB` +
    (chk ? `  median h=${chk.h} bottom=${chk.bottom} torso=${chk.torsoX.toFixed(1)}` : '  (alpha 校验未取到)'));
}

console.log(`\n目标：人物高 ${TARGET_H} · 脚底 ${TARGET_BOTTOM} · 中轴 ${TARGET_X}（13 支统一）`);
