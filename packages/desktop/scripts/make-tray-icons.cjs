/**
 * 由 exe 图标（build/icon.png，汐音立绘）缩放生成托盘图标 —— 就是立绘本身的缩小版。
 *
 *   npx electron scripts/make-tray-icons.cjs
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
const TARGETS = [
  ['tray-16.png', 16],
  ['tray-32.png', 32],
  ['tray-mac.png', 22],
  ['tray-mac@2x.png', 44],
]

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(SRC)
  if (base.isEmpty()) throw new Error(`icon missing: ${SRC}`)
  fs.mkdirSync(OUT, { recursive: true })
  for (const [file, size] of TARGETS) {
    const png = base.resize({ width: size, height: size, quality: 'best' }).toPNG()
    fs.writeFileSync(path.join(OUT, file), png)
    console.log(`${file} ${size}x${size} ${png.length}B`)
  }
  app.quit()
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
