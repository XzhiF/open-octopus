#!/usr/bin/env node
/**
 * Build the Electron extraResources:
 *   resources/runtime/node        standalone Node runtime for the sidecar
 *   resources/server              self-contained @octopus/server (dist + prod node_modules)
 *   resources/web                 Vite SPA dist
 *   resources/packages/core-pack  core-pack data (cwd-relative lookups)
 *
 * The sidecar runs on the bundled Node binary instead of ELECTRON_RUN_AS_NODE.
 * That keeps better-sqlite3 on the Node ABI, so the same node_modules copy can
 * serve `pnpm dev` and the packaged app without an in-place native rebuild.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')
const resources = path.join(desktopDir, 'resources')
const store = path.join(repoRoot, 'node_modules', '.pnpm')

function findStoreBin(packageName, relativeBin) {
  const dirs = fs
    .readdirSync(store)
    .filter((name) => name.startsWith(`${packageName}@`))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const candidate = path.join(store, dir, 'node_modules', packageName, relativeBin)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`cannot locate ${packageName}/${relativeBin} in pnpm store`)
}

const run = (command, args, cwd, opts = {}) => {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    // Windows 上 pnpm 只有 pnpm.cmd，execFile 不走 PATHEXT —— 必须经 shell 解析，
    // 否则 `spawnSync pnpm ENOENT`（2026-11-19 首次 Windows 打包复现）。
    shell: opts.shell ?? false,
    env: {
      ...process.env,
      CI: 'true',
      npm_config_confirm_modules_purge: 'false',
      ...(opts.env ?? {}),
    },
  })
}

/** pnpm 的调用别名：Windows 用 .cmd + shell，其它平台直接可执行。 */
const runPnpm = (args, cwd) =>
  run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, cwd, {
    shell: process.platform === 'win32',
  })

// Windows：杀软/资源管理器/终端 cwd 都可能短暂占住目录，重试几次再放弃。
fs.rmSync(resources, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
fs.mkdirSync(resources, { recursive: true })

const tsupCli = findStoreBin('tsup', 'dist/cli-default.js')
const viteBin = findStoreBin('vite', 'bin/vite.js')
const serverDir = path.join(repoRoot, 'packages', 'server')
const webAppDir = path.join(repoRoot, 'packages', 'web-app')

run(process.execPath, [tsupCli, 'src/index.ts', '--format', 'esm,cjs', '--dts'], serverDir)
run(process.execPath, [viteBin, 'build'], webAppDir)

const deployDir = path.join(resources, 'server')
// Windows 上 pnpm 的默认 isolated 布局用「绝对路径 junction」连向 .pnpm，
// 一旦把 node_modules 改名/搬进打包产物全部断链；hoisted 布局铺平为真实目录，
// 才可能跨机器自包含。ignore-scripts 避免 deploy 重新 node-gyp 编译
// better-sqlite3（本机没有 VS 工具链）；编译好的 .node 在下面手动补进去。
runPnpm(
  [
    '--config.node-linker=hoisted',
    '--config.ignore-scripts=true',
    '--filter', '@octopus/server',
    'deploy', '--prod', '--legacy', deployDir,
  ],
  repoRoot,
)

// better-sqlite3 的源码包不含预编译二进制（store 里那份才带 build/Release）。
// 从工作区的 node_modules 直接拷编译产物，保证随包 Node 能 require。
const sqliteBuilt = path.join(
  serverDir, 'node_modules', 'better-sqlite3', 'build', 'Release',
)
const sqliteDest = path.join(deployDir, 'node_modules', 'better-sqlite3', 'build', 'Release')
if (!fs.existsSync(sqliteBuilt)) {
  throw new Error(`better-sqlite3 build output missing: ${sqliteBuilt}`)
}
fs.mkdirSync(path.dirname(sqliteDest), { recursive: true })
fs.cpSync(sqliteBuilt, sqliteDest, { recursive: true })
console.log(`✓ better-sqlite3 binary: ${sqliteDest}`)

// Drop links that escape the deploy tree; they would break in the packaged app
// and let tooling walk into the source workspace.
function removeExternalSymlinks(rootDir) {
  const rootReal = fs.realpathSync(rootDir)
  let removed = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        let target
        try { target = fs.realpathSync(p) } catch { fs.unlinkSync(p); removed++; continue }
        if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
          fs.unlinkSync(p)
          removed++
          console.log(`  removed external link ${path.relative(deployDir, p)} -> ${target}`)
        }
      } else if (entry.isDirectory() && entry.name !== '.git') {
        walk(p)
      }
    }
  }
  walk(rootDir)
  console.log(`✓ external links removed: ${removed}`)
}
removeExternalSymlinks(deployDir)

// 依赖树必须保留 `node_modules` 这个目录名：Node 只在名为 node_modules 的祖先目录里
// 解析裸模块，ESM 更是不认 NODE_PATH。改名成 vendor 后 chokidar→readdirp 这类
// 扁平布局的 ESM 依赖会直接 ERR_MODULE_NOT_FOUND（Windows hoisted 布局实测）。
const modulesDir = path.join(deployDir, 'node_modules')
for (const entry of ['src', 'scripts', 'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts']) {
  fs.rmSync(path.join(deployDir, entry), { recursive: true, force: true })
}
console.log(`✓ deployed deps: ${modulesDir}`)

// Bundle the Node runtime that runs the sidecar.
// Windows 只能执行带 .exe 的可执行文件 —— 复制成无扩展名的 `node` 会 spawn ENOENT。
const runtimeDir = path.join(resources, 'runtime')
fs.mkdirSync(runtimeDir, { recursive: true })
const nodeDest = path.join(runtimeDir, process.platform === 'win32' ? 'node.exe' : 'node')
fs.copyFileSync(process.execPath, nodeDest)
fs.chmodSync(nodeDest, 0o755)
console.log(`✓ node runtime: ${nodeDest}`)

const webSrc = path.join(repoRoot, 'packages', 'web-app', 'dist')
const webDest = path.join(resources, 'web')
if (!fs.existsSync(path.join(webSrc, 'index.html'))) throw new Error('web dist missing; build failed')
fs.cpSync(webSrc, webDest, { recursive: true })

// 托盘图标在主进程里按 process.resourcesPath/tray 读（build/ 只在构建期有用）。
const traySrc = path.join(desktopDir, 'build', 'tray')
const trayDest = path.join(resources, 'tray')
if (!fs.existsSync(traySrc)) throw new Error(`tray icons missing: ${traySrc}`)
fs.cpSync(traySrc, trayDest, { recursive: true })

const corePackSrc = path.join(repoRoot, 'packages', 'core-pack')
const corePackDest = path.join(resources, 'packages', 'core-pack')
fs.mkdirSync(corePackDest, { recursive: true })
for (const entry of fs.readdirSync(corePackSrc)) {
  if (entry === 'node_modules' || entry === 'dist') continue
  fs.cpSync(path.join(corePackSrc, entry), path.join(corePackDest, entry), { recursive: true })
}

// Prove the bundled runtime can load the deployed native module and the SPA exists.
run(
  nodeDest,
  [
    '-e',
    [
      `const Database = require(${JSON.stringify(path.join(modulesDir, 'better-sqlite3'))});`,
      `const db = new Database(':memory:');`,
      `db.prepare('select 1 as x').get();`,
      `db.close();`,
      `console.log('sidecar runtime OK');`,
    ].join(''),
  ],
  resources,
)

for (const [label, file] of [
  ['server entry', path.join(deployDir, 'dist', 'index.js')],
  ['better-sqlite3', path.join(modulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')],
  ['node runtime', nodeDest],
  ['web index', path.join(webDest, 'index.html')],
  ['tray icons', path.join(trayDest, process.platform === 'darwin' ? 'tray-mac.png' : 'tray-16.png')],
  ['core-pack skills', path.join(corePackDest, 'skills')],
]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`)
  console.log(`✓ ${label}: ${file}`)
}

console.log(`\nresources ready: ${resources}`)
