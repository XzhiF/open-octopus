import { app, BrowserWindow, dialog, screen, session, shell } from 'electron'
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

function startSidecar(): void {
  if (isDev) return

  const resources = process.resourcesPath
  const entry = path.join(resources, 'server', 'dist', 'index.js')
  const webDir = path.join(resources, 'web')
  const nodeBin = path.join(resources, 'runtime', 'node')
  if (!fs.existsSync(entry)) throw new Error(`sidecar missing: ${entry}`)
  if (!fs.existsSync(nodeBin)) throw new Error(`bundled node missing: ${nodeBin}`)
  if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error(`web dist missing: ${webDir}`)

  const dbPath =
    process.env.OCTOPUS_DESKTOP_DB_PATH ??
    path.join(os.homedir(), '.octopus', 'db', 'octopus.db')
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
      NODE_PATH: path.join(resources, 'server', 'vendor'),
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
      const response = await fetch(url)
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

  win.once('ready-to-show', () => win.show())
  win.on('close', () => saveWindowState(win))
  win.on('closed', () => { mainWindow = null })
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
  if (isDev) {
    await waitFor(DEV_URL, 15_000)
  } else {
    startSidecar()
    await waitFor(`${BASE_URL}/api/actuator/ready`, 30_000)
  }

  session.defaultSession.on('will-download', (_event, item) => {
    const target = path.join(app.getPath('downloads'), item.getFilename())
    item.setSavePath(target)
  })

  mainWindow = createWindow()
  await mainWindow.loadURL(isDev ? DEV_URL : BASE_URL)
  if (isDev && process.env.OCTOPUS_DESKTOP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

app.setName('Octopus')
app.setAppUserModelId('com.octopus.desktop')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady()
    .then(bootstrap)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('Octopus 启动失败', message)
      void stopSidecar().finally(() => app.exit(1))
    })

  app.on('window-all-closed', () => app.quit())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      void mainWindow.loadURL(isDev ? DEV_URL : BASE_URL)
    }
  })

  app.on('before-quit', (event) => {
    if (quitting || !sidecar) return
    event.preventDefault()
    quitting = true
    void stopSidecar().finally(() => app.exit(0))
  })
}
