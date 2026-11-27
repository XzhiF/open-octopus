import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray,
  type NativeImage,
} from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const isDev = !app.isPackaged
const DESKTOP_PORT = Number(process.env.OCTOPUS_DESKTOP_PORT ?? 47820)
const DEV_URL = process.env.OCTOPUS_DESKTOP_DEV_URL ?? 'http://localhost:3000'
const BASE_URL = `http://127.0.0.1:${DESKTOP_PORT}`

let mainWindow: BrowserWindow | null = null
let sidecar: ChildProcess | null = null
let sidecarLog: fs.WriteStream | null = null
let quitting = false
// 已经进入「停 sidecar → exit」的异步收尾，防止 before-quit 重入。
let quitInProgress = false

// 托盘常驻。桌面壳就是 server 的宿主：关窗只隐藏，sidecar 继续跑，
// 手机 / 局域网还能连上来（远程控制的前提）。真退出只走托盘菜单。
let tray: Tray | null = null
let sidecarReady = false
// 本次启动是否直接待在托盘里（`--tray`，登录自启走这条）。
let startHidden = false
/** 登录自启时附加的参数；Windows 靠它决定「起来后不弹窗」。 */
const TRAY_LAUNCH_ARGS = ['--tray']

// 冷启动时后端 routesReady 之前不接请求（packages/server/src/index.ts 里
// listen 回调那段同步初始化，本机实测 40–75s）。窗口必须在这个等待之前就出现，
// 否则用户双击后几十秒里既无窗口也无任务栏图标，只会判定「打不开」。
const LOADING_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0A0A0C;color:#c8c8d0;
  font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  display:flex;align-items:center;justify-content:center;user-select:none}
.box{text-align:center}
.ring{width:34px;height:34px;margin:0 auto 18px;border:2px solid rgba(255,255,255,.12);
  border-top-color:#7aa2ff;border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.t{font-size:15px;letter-spacing:.4px}
.s{margin-top:8px;font-size:12px;color:#6b6b78}
</style></head><body><div class="box"><div class="ring"></div>
<div class="t">Octopus 正在启动…</div><div class="s" id="s">正在初始化本地服务</div></div>
<script>let n=0;setInterval(()=>{n++;document.getElementById('s').textContent='正在初始化本地服务 · '+n+'s'},1000)</script>
</body></html>`

function loadingUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState(): { width: number; height: number; x?: number; y?: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) as Record<string, unknown>
    const width = Number(raw.width)
    const height = Number(raw.height)
    const x = Number(raw.x)
    const y = Number(raw.y)
    return {
      width: Number.isFinite(width) && width >= 1024 ? width : 1440,
      height: Number.isFinite(height) && height >= 700 ? height : 900,
      x: Number.isFinite(x) ? x : undefined,
      y: Number.isFinite(y) ? y : undefined,
    }
  } catch {
    return { width: 1440, height: 900 }
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds()
    fs.writeFileSync(windowStatePath(), JSON.stringify(bounds))
  } catch {
    // state persistence is best-effort
  }
}

function isAppOrigin(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.origin === BASE_URL) return true
    if (isDev && (parsed.origin === 'http://localhost:3000' || parsed.origin === 'http://127.0.0.1:3000')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

function openExternal(url: string): void {
  if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
}

function openFromRenderer(url: string): void {
  if (isAppOrigin(url)) {
    void mainWindow?.loadURL(url)
    return
  }
  openExternal(url)
}

// ── 托盘 ───────────────────────────────────────────────────────────

function trayIconPath(): string {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'build', 'tray')
  return process.platform === 'darwin'
    ? path.join(dir, 'tray-mac.png')
    : path.join(dir, 'tray-16.png')
}

function loadTrayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    // 图标是汐音立绘（彩色圆形头像 + 品牌色环），不能设成模板图 ——
    // 模板化会把整块实心区域压成一枚黑圆。同名 tray-mac@2x.png 自动带上。
    return nativeImage.createFromPath(trayIconPath())
  }
  // Windows / Linux：1x、2x 两档都塞进去，系统按 DPI 挑最合适的一张。
  const dir = path.dirname(trayIconPath())
  const image = nativeImage.createEmpty()
  for (const [file, scale] of [['tray-16.png', 1], ['tray-32.png', 2]] as const) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) continue
    image.addRepresentation({
      scaleFactor: scale,
      width: 16 * scale,
      height: 16 * scale,
      buffer: fs.readFileSync(full),
    })
  }
  return image
}

function loginItemEnabled(): boolean {
  if (!app.isPackaged) return false
  return process.platform === 'darwin'
    ? app.getLoginItemSettings().openAtLogin
    : app.getLoginItemSettings({ args: TRAY_LAUNCH_ARGS }).openAtLogin
}

function setLoginItem(enabled: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: TRAY_LAUNCH_ARGS,
    // 只有 macOS 13 以前认这个；新系统由「登录项」自行决定，留着无害。
    ...(process.platform === 'darwin' ? { openAsHidden: true } : {}),
  })
  refreshTrayMenu()
}

function refreshTrayMenu(): void {
  if (!tray) return
  tray.setToolTip(`Octopus · ${sidecarReady ? '服务已就绪' : '启动中'}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: loginItemEnabled(),
      // 未打包时注册的是 electron.exe，没有意义。
      enabled: app.isPackaged,
      click: (item) => setLoginItem(item.checked),
    },
    { type: 'separator' },
    { label: '退出 Octopus', click: () => void requestQuit() },
  ]))
}

function createTray(): void {
  if (tray) return
  const image = loadTrayIcon()
  if (image.isEmpty()) {
    // 图标丢了不该把应用拖死：没有托盘时关窗照旧退出（close 处理器里有判空）。
    console.error(`[tray] icon missing: ${trayIconPath()}`)
    return
  }
  tray = new Tray(image)
  // Windows：左键回窗口、右键出菜单。macOS 设了菜单后左键也是开菜单。
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow()
  })
  refreshTrayMenu()
}

function showMainWindow(): void {
  startHidden = false
  if (process.platform === 'darwin') void app.dock?.show()
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    void mainWindow.loadURL(isDev ? DEV_URL : BASE_URL)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  if (process.platform === 'darwin') app.dock?.hide()
}

/**
 * 托盘「退出」：关窗已改成收进托盘，原来挂在 window close 上的
 * 「agent 还在跑」守卫要挪到这里，否则退出会静默打断在跑的会话。
 */
async function hasRunningAgents(): Promise<boolean> {
  // dev 没有 sidecar，服务跑在 pnpm dev 的 3001，与窗口不同源，不做这项检查。
  if (isDev || !sidecarReady) return false
  try {
    const response = await fetch(`${BASE_URL}/api/agent/sessions/running`, {
      // /api/agent 只校验 Bearer 前缀（见 server routes/agent/middleware.ts）。
      headers: { Authorization: 'Bearer desktop-shell' },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { items?: unknown[] }
    return Array.isArray(body.items) && body.items.length > 0
  } catch {
    return false
  }
}

async function requestQuit(): Promise<void> {
  if (await hasRunningAgents()) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['退出并中断', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Agent 正在工作',
      message: '还有 agent 正在工作，退出会先中断它。',
      detail: '被中断的这一轮会以「已中断」收尾，已经产出的内容保留在会话里。',
    })
    if (choice !== 0) return
  }
  app.quit()
}

function startSidecar(): void {
  if (isDev) return

  const resources = process.resourcesPath
  const entry = path.join(resources, 'server', 'dist', 'index.js')
  const webDir = path.join(resources, 'web')
  const nodeBin = path.join(
    resources,
    'runtime',
    process.platform === 'win32' ? 'node.exe' : 'node',
  )
  if (!fs.existsSync(entry)) throw new Error(`sidecar missing: ${entry}`)
  if (!fs.existsSync(nodeBin)) throw new Error(`bundled node missing: ${nodeBin}`)
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error(`web dist missing: ${webDir}`)

  // 2026-11-19 用户口径：桌面壳 = 对外分发的 prod 形态，数据也跟 prod 走同一份库
  // （dev 的 octopus.db 留给 `pnpm dev` / CLI）。要指回 dev 库用
  // OCTOPUS_DESKTOP_DB_PATH 覆盖。
  const dbPath =
    process.env.OCTOPUS_DESKTOP_DB_PATH ??
    path.join(os.homedir(), '.octopus', 'db', 'octopus-prod.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  sidecarLog = fs.createWriteStream(path.join(logDir, 'sidecar.log'), { flags: 'a' })

  sidecar = spawn(nodeBin, [entry], {
    cwd: resources,
    env: {
      ...process.env,
      PORT: String(DESKTOP_PORT),
      OCTOPUS_HOST: '127.0.0.1',
      OCTOPUS_DB_PATH: dbPath,
      OCTOPUS_WEB_DIR: webDir,
      OCTOPUS_BRANCH: 'desktop',
      OCTOPUS_HOST_PID: String(process.pid),
      OCTOPUS_HOST_PORTS: String(DESKTOP_PORT),
      // M4：设置页「启用远程拉起」用这个目录里的 install-remote.ps1。
      OCTOPUS_REMOTE_DIR: path.join(resources, 'remote'),
      // 依赖树保留 node_modules 原名（ESM 的裸模块解析不认 NODE_PATH）；
      // NODE_PATH 只作为 CJS 兜底，与部署树保持一致。
      NODE_PATH: path.join(resources, 'server', 'node_modules'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pipe = (stream: NodeJS.ReadableStream | null, prefix: string) => {
    stream?.on('data', (data: Buffer | string) => {
      const text = data.toString()
      process.stdout.write(`${prefix}${text}`)
      sidecarLog?.write(text)
    })
  }
  pipe(sidecar.stdout, '[sidecar] ')
  pipe(sidecar.stderr, '[sidecar:err] ')

  sidecar.on('exit', (code, signal) => {
    sidecarLog?.write(`\n[sidecar] exited code=${code} signal=${signal}\n`)
    if (quitting) return
    dialog.showErrorBox('Octopus 后端退出', `后端进程意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
    app.quit()
  })
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sidecar && sidecar.exitCode !== null) {
      throw new Error(`后端进程提前退出（code=${sidecar.exitCode}）`)
    }
    try {
      // 单次请求必须有上限：后端事件循环被初始化卡住时，连接会被 accept 队列
      // 接住却迟迟不回包，没有 signal 的 fetch 会把整个等待循环钉死在这一次调用上，
      // 总超时形同虚设（2026-11-19 桌面壳冷启动实测）。
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待 ${url} 超时（${Math.round(timeoutMs / 1000)}s）`)
}

async function stopSidecar(): Promise<void> {
  const child = sidecar
  sidecar = null
  if (!child || child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

function createWindow(): BrowserWindow {
  const state = readWindowState()
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0A0A0C',
    title: 'Octopus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => {
    if (!startHidden) win.show()
  })
  // 托盘常驻：关窗 = 收进托盘，sidecar 和窗口都留着（手机还要靠它连）。
  // 没有托盘图标时保持旧行为真退出，否则这个进程就没人找得到了。
  win.on('close', (event) => {
    saveWindowState(win)
    if (quitting || !tray) return
    event.preventDefault()
    hideMainWindow()
  })
  win.on('closed', () => { mainWindow = null })
  // 渲染层装了「agent 在跑就拦关闭」的 beforeunload 守卫（web-app
  // cockpit/shell/use-cockpit-close-guard）。Chromium 默认对「拦了 unload」
  // 静默取消关闭，窗口像卡死一样 —— 这里补一个真确框：
  // 「关闭并中断」放行（渲染层 pagehide 会先发停流请求），其余保持窗口原样。
  win.webContents.on('will-prevent-unload', (event) => {
    if (win.isDestroyed()) return
    const quit = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['关闭并中断', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Agent 正在工作',
      message: '还有 agent 正在工作，关闭窗口会先中断它。',
      detail: '被中断的这一轮会以「已中断」收尾，已经产出的内容保留在会话里。',
    })
    if (quit === 0) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openFromRenderer(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return
    event.preventDefault()
    openExternal(url)
  })

  const workArea = screen.getPrimaryDisplay().workAreaSize
  if (win.getBounds().width > workArea.width || win.getBounds().height > workArea.height) {
    win.center()
  }

  return win
}

async function bootstrap(): Promise<void> {
  startHidden = process.argv.includes('--tray')
  if (!startHidden && process.platform === 'darwin' && app.isPackaged) {
    // macOS 13+ 的登录项不传 args，只能由系统告诉我们这次是不是自启起来的。
    startHidden = app.getLoginItemSettings().wasOpenedAtLogin
  }
  createTray()
  if (startHidden && process.platform === 'darwin') app.dock?.hide()

  // 先开窗、先给反馈：下面的 sidecar + waitFor 冷启动要几十秒，窗口必须已经立起来。
  const win = createWindow()
  mainWindow = win
  await win.loadURL(loadingUrl())
  if (win.isDestroyed()) return
  if (!startHidden) win.show()

  if (isDev) {
    await waitFor(DEV_URL, 15_000)
  } else {
    startSidecar()
    // 本机冷启动实测 44–75s（见文件头 LOADING_HTML 注释），30s 会把正常启动判成失败。
    await waitFor(`${BASE_URL}/api/actuator/ready`, 120_000)
  }
  sidecarReady = true
  refreshTrayMenu()

  session.defaultSession.on('will-download', (_event, item) => {
    const target = path.join(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
  })

  if (win.isDestroyed()) return
  await win.loadURL(isDev ? DEV_URL : BASE_URL)
  if (isDev && process.env.OCTOPUS_DESKTOP_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

app.setName('Octopus')
app.setAppUserModelId('com.octopus.desktop')

// 渲染层 → 系统文件管理器（本舱目录窗「资源管理器」）。只接受绝对路径：
// 渲染层拿到的是服务端 tree 接口的 dir，这里再兜一次，避免变成任意打开入口。
ipcMain.handle('octopus:reveal-path', async (_event, target: unknown) => {
  if (typeof target !== 'string' || !target.trim()) return false
  if (!path.isAbsolute(target)) return false
  try {
    const stats = fs.statSync(target)
    if (stats.isDirectory()) await shell.openPath(target)
    else shell.showItemInFolder(target)
    return true
  } catch {
    return false
  }
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Octopus 启动失败', message)
      void stopSidecar().finally(() => app.exit(1))
    })

  // 有托盘时常驻进程继续为手机 / 局域网服务；真退出由托盘菜单发起。
  app.on('window-all-closed', () => {
    if (!tray) app.quit()
  })
  app.on('activate', () => showMainWindow())

  app.on('before-quit', (event) => {
    // 真退出：关窗处理器必须让路，否则 quit 会被它拦下来、藏回托盘，
    // 于是「退出」永远退不掉。
    quitting = true
    if (quitInProgress) return
    quitInProgress = true
    // 托盘退出时窗口没走 close，几何要在这里补一次。
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow)
    if (sidecar) event.preventDefault()
    // 没有 sidecar（dev / 已经退出）时也走同一条收尾：直接 exit，
    // 不让关闭流程再去和窗口 close 处理器、渲染层 unload 守卫拉扯。
    void stopSidecar().finally(() => app.exit(0))
  })
}
