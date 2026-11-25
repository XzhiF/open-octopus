#!/usr/bin/env node
/**
 * 带代理打包：把代理注入子进程环境，再依次跑 build-main → prepare-resources → electron-builder。
 *
 * 为什么需要代理：一次打包有三段要走外网，国内直连经常 ECONNRESET：
 *   1. electron-builder 拉 electron 发行包的 SHASUMS256.txt 校验文件（每次都拉，
 *      拉不到就会把 %LOCALAPPDATA%\electron\Cache 里已缓存的 130MB zip 判为无效并重下）；
 *   2. prepare-resources 里的 `pnpm deploy` 拉生产依赖（registry.npmjs.org）；
 *   3. electron-builder 首次下载 NSIS / winCodeSign 等工具链。
 *
 * 用法：
 *   pnpm desktop:dist:proxy                  # 自动读取 Windows 系统代理（也可用 HTTP(S)_PROXY 环境变量）
 *   pnpm desktop:pack:proxy                  # 同上，但只出 win-unpacked（--dir）
 *   pnpm desktop:dist:proxy -- --proxy http://127.0.0.1:7890
 *   pnpm desktop:dist:proxy -- --no-proxy    # 显式直连
 *   node scripts/pack.mjs --dry-run          # 只打印代理 / electron zip 缓存状态，不打包
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')

const HELP = `用法: node scripts/pack.mjs [--dir] [--proxy <url> | --no-proxy] [--dry-run]

  --dir          只产出 release/win-unpacked（等价于 electron-builder --dir）
  --proxy <url>  指定代理，如 http://127.0.0.1:7890（不带协议默认 http://）
  --no-proxy     忽略系统代理 / 环境变量，直连
  --dry-run      只打印代理与 electron zip 缓存状态
  -h, --help     显示本帮助

不带 --proxy 时按顺序查找：HTTP(S)_PROXY 环境变量 → Windows 系统代理设置。`

function parseArgs(argv) {
  const opts = { dir: false, dryRun: false, help: false, proxy: null, noProxy: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--dir') opts.dir = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--no-proxy') opts.noProxy = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--proxy') opts.proxy = argv[++i] ?? ''
    else if (arg.startsWith('--proxy=')) opts.proxy = arg.slice('--proxy='.length)
    else {
      console.error(`未知参数: ${arg}\n\n${HELP}`)
      process.exit(1)
    }
  }
  return opts
}

/** `127.0.0.1:7890` → `http://127.0.0.1:7890`；已带协议的原样返回。 */
function toProxyUrl(hostPort) {
  if (!hostPort) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(hostPort) ? hostPort : `http://${hostPort}`
}

/** Windows 的 ProxyServer 既可能是 `host:port`，也可能是 `http=host:port;https=host:port;socks=host:port`。 */
function parseWindowsProxyServer(raw) {
  if (!raw.includes('=')) {
    return { http: raw, https: raw, socks: null }
  }
  const out = { http: null, https: null, socks: null }
  for (const part of raw.split(';')) {
    const [scheme, hostPort] = part.split('=')
    if (!hostPort) continue
    const key = scheme.trim().toLowerCase()
    if (key === 'http' || key === 'https' || key === 'socks') out[key] = hostPort.trim()
  }
  return out
}

function readWindowsSystemProxy() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true },
    )
    const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/im.exec(out)
    if (!enabled || Number.parseInt(enabled[1], 16) !== 1) return null
    const server = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/im.exec(out)
    return server ? parseWindowsProxyServer(server[1].trim()) : null
  } catch {
    return null
  }
}

function resolveProxy(opts) {
  if (opts.noProxy) return { source: '--no-proxy' }
  if (opts.proxy) {
    return { source: '--proxy', http: toProxyUrl(opts.proxy), https: toProxyUrl(opts.proxy) }
  }
  const envHttp = process.env.HTTP_PROXY || process.env.http_proxy
  const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy
  if (envHttp || envHttps) {
    const http = toProxyUrl(envHttp || envHttps)
    const https = toProxyUrl(envHttps || envHttp)
    return { source: 'HTTP(S)_PROXY 环境变量', http, https }
  }
  if (process.platform === 'win32') {
    const sys = readWindowsSystemProxy()
    if (sys) {
      // socks-only 的代理 http(s)-proxy-agent 用不了，交给调用方报错
      if (sys.socks && !sys.http && !sys.https) return { source: 'Windows 系统代理', socks: toProxyUrl(sys.socks) }
      const http = toProxyUrl(sys.http || sys.https)
      const https = toProxyUrl(sys.https || sys.http)
      return { source: 'Windows 系统代理', http, https, socks: sys.socks ? toProxyUrl(sys.socks) : null }
    }
  }
  return { source: '未找到' }
}

/** electron-builder 的下载走 got agent，读 HTTP(S)_PROXY；pnpm deploy 读 npm_config_* 与环境变量。 */
function applyProxyEnv(proxy) {
  if (!proxy.http) return
  Object.assign(process.env, {
    HTTP_PROXY: proxy.http,
    HTTPS_PROXY: proxy.https,
    http_proxy: proxy.http,
    https_proxy: proxy.https,
    npm_config_proxy: proxy.http,
    npm_config_https_proxy: proxy.https,
  })
}

function electronCacheRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'electron')
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron')
}

/** @electron/get 把 zip 放在 <cache>/<sha256(URL 目录)>/ 下；这里只扫文件名，不关心镜像。 */
function findElectronZip(version, platformName, arch) {
  const zipName = `electron-v${version}-${platformName}-${arch}.zip`
  const root = electronCacheRoot()
  if (!fs.existsSync(root)) return null
  for (const dir of fs.readdirSync(root)) {
    const candidate = path.join(root, dir, zipName)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && stat.size > 10 * 1024 * 1024) return { path: candidate, size: stat.size }
    } catch {
      // 目录里没有这个版本，继续
    }
  }
  return null
}

function readElectronVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(desktopDir, 'node_modules', 'electron', 'package.json'), 'utf8'))
    return pkg.version
  } catch {
    return null
  }
}

function runNode(scriptRelPath) {
  execFileSync(process.execPath, [path.join(desktopDir, scriptRelPath)], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: process.env,
  })
}

/** 流式执行并同时留存输出，用于识别 Windows 目录锁这类可重试错误。 */
function runStreaming(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['inherit', 'pipe', 'pipe'] })
    let output = ''
    for (const [stream, dest] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        output += chunk.toString()
        dest.write(chunk)
      })
    }
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

const WINDOWS_LOCK_ERROR = /EBUSY|EPERM|resource busy or locked|operation not permitted/i

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }

  const proxy = resolveProxy(opts)
  if (proxy.socks && !proxy.http) {
    console.error(
      `[pack] 当前代理只有 SOCKS（${proxy.socks}），Node 的 http(s)-proxy-agent 不支持 SOCKS。\n` +
        `       请在代理软件里开启 HTTP 代理端口，或用 --proxy http://127.0.0.1:<端口> 指定。`,
    )
    process.exit(1)
  }

  if (proxy.http) {
    applyProxyEnv(proxy)
    console.log(`[pack] 代理：${proxy.http}（来自 ${proxy.source}）`)
  } else {
    console.log(`[pack] 代理：未使用（${proxy.source}）—— 国内网络下拉依赖/校验文件可能 ECONNRESET`)
  }

  const version = readElectronVersion()
  if (version) {
    const platformName = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
    const zip = findElectronZip(version, platformName, process.arch)
    if (zip) {
      console.log(`[pack] Electron zip 缓存：命中 electron-v${version}-${platformName}-${process.arch}.zip（${(zip.size / 1024 / 1024).toFixed(0)} MB）—— 本次不重新下载`)
    } else {
      console.log(`[pack] Electron zip 缓存：未命中 —— 本次会下载 electron-v${version}-${platformName}-${process.arch}.zip 到 ${electronCacheRoot()}`)
    }
    // 每次打包仍会拉 SHASUMS256.txt（约 KB 级），electron-builder 日志里打的是 downloaded label=electron
    console.log('[pack] 提示：即使命中缓存，electron-builder 仍会拉 SHASUMS256.txt 校验文件；日志中的 "downloaded label=electron" 通常指它，不是 130MB 的 zip。')
  }

  if (opts.dryRun) {
    console.log('[pack] --dry-run：到此为止，未执行打包。')
    return
  }

  console.log('\n[pack] 1/3 build-main')
  runNode(path.join('scripts', 'build-main.mjs'))
  console.log('\n[pack] 2/3 prepare-resources')
  runNode(path.join('scripts', 'prepare-resources.mjs'))
  console.log('\n[pack] 3/3 electron-builder')
  const builderCli = path.join(desktopDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  const builderArgs = [builderCli, ...(opts.dir ? ['--dir'] : [])]
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { code, output } = await runStreaming(process.execPath, builderArgs, {
      cwd: desktopDir,
      env: process.env,
    })
    if (code === 0) break
    if (attempt < MAX_ATTEMPTS && WINDOWS_LOCK_ERROR.test(output)) {
      // Windows 上刚解压出的 win-unpacked.tmp 常被杀软/索引短暂占住，会导致
      // EPERM rename / EBUSY rmdir；隔几秒重试即可。
      console.warn(`[pack] electron-builder 第 ${attempt} 次失败（release 目录被短暂占用），5 秒后重试...`)
      await new Promise((resolve) => setTimeout(resolve, 5000))
      continue
    }
    process.exit(code ?? 1)
  }
  console.log(`\n[pack] 完成：${path.join(desktopDir, 'release')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
