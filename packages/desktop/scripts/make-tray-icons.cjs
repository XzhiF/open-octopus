/**
 * 由 exe 图标（build/icon.png，汐音立绘）生成托盘图标。
 *
 *   npx electron scripts/make-tray-icons.cjs
 *
 * 立绘直接缩到 16px 会糊成一团浅色，所以：裁头部方图 → 轻微提对比/饱和度 →
 * 圆形裁切 + 品牌色细环（浅色/深色任务栏都立得住）。
 *
 * 产物落在 build/tray/，打包时由 prepare-resources.mjs 拷进 resources/tray：
 *   tray-16.png / tray-32.png     Windows / Linux（1x、2x）
 *   tray-mac.png / tray-mac@2x.png macOS 菜单栏（22pt，同名 @2x 自动带上）
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon.png')
const OUT = path.join(ROOT, 'build', 'tray')

/** 头部方图（512x512 立绘里的坐标）。 */
const CROP = { x: 96, y: 32, width: 320, height: 320 }
const ACCENT = [0x7a, 0xa2, 0xff] // #7AA2FF，与启动/舰桥同色
const TARGETS = [
  ['tray-16.png', 16],
  ['tray-32.png', 32],
  ['tray-mac.png', 22],
  ['tray-mac@2x.png', 44],
]

function boost(img, contrast, sat) {
  const size = img.getSize()
  const bmp = Buffer.from(img.toBitmap()) // BGRA
  const lum = (b, g, r) => 0.299 * r + 0.587 * g + 0.114 * b
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i]
    const g = bmp[i + 1]
    const r = bmp[i + 2]
    const l = lum(b, g, r)
    const map = (c) =>
      Math.max(0, Math.min(255, Math.round(128 + (l + (c - l) * sat - 128) * contrast)))
    bmp[i] = map(b)
    bmp[i + 1] = map(g)
    bmp[i + 2] = map(r)
  }
  return nativeImage.createFromBitmap(bmp, size)
}

/** 圆形裁切 + 外环，返回预乘 BGRA。 */
function circle(img, size, ringW) {
  const srcBmp = img.toBitmap()
  const out = Buffer.alloc(size * size * 4)
  const R = size / 2
  const SS = 8 // 每像素超采样，边缘才有抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0
      let ring = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - R
          const dy = y + (sy + 0.5) / SS - R
          const d = Math.hypot(dx, dy)
          if (d > R - 0.5) continue
          inside++
          if (d > R - 0.5 - ringW) ring++
        }
      }
      if (inside === 0) continue
      const alpha = inside / (SS * SS)
      const ringShare = ring / inside
      const si = (y * size + x) * 4
      const mix = (c, a) => Math.round((c * (1 - ringShare) + a * ringShare) * alpha)
      const oi = (y * size + x) * 4
      out[oi] = mix(srcBmp[si], ACCENT[2]) // B
      out[oi + 1] = mix(srcBmp[si + 1], ACCENT[1]) // G
      out[oi + 2] = mix(srcBmp[si + 2], ACCENT[0]) // R
      out[oi + 3] = Math.round(alpha * 255)
    }
  }
  return nativeImage.createFromBitmap(out, { width: size, height: size })
}

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(SRC).crop(CROP)
  if (base.isEmpty()) throw new Error(`icon missing: ${SRC}`)
  fs.mkdirSync(OUT, { recursive: true })
  for (const [file, size] of TARGETS) {
    const small = boost(base.resize({ width: size, height: size, quality: 'best' }), 1.15, 1.25)
    const png = circle(small, size, size / 12).toPNG()
    fs.writeFileSync(path.join(OUT, file), png)
    console.log(`${file} ${size}x${size} ${png.length}B`)
  }
  app.quit()
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
