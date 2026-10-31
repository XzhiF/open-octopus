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

const run = (command, args, cwd) => {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      CI: 'true',
      npm_config_confirm_modules_purge: 'false',
    },
  })
}

fs.rmSync(resources, { recursive: true, force: true })
fs.mkdirSync(resources, { recursive: true })

const tsupCli = findStoreBin('tsup', 'dist/cli-default.js')
const viteBin = findStoreBin('vite', 'bin/vite.js')
const serverDir = path.join(repoRoot, 'packages', 'server')
const webAppDir = path.join(repoRoot, 'packages', 'web-app')

run(process.execPath, [tsupCli, 'src/index.ts', '--format', 'esm,cjs', '--dts'], serverDir)
run(process.execPath, [viteBin, 'build'], webAppDir)

const deployDir = path.join(resources, 'server')
run('pnpm', ['--filter', '@octopus/server', 'deploy', '--prod', '--legacy', deployDir], repoRoot)

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

// electron-builder filters node_modules out of extraResources. Rename the
// self-contained dependency tree; the sidecar resolves it via NODE_PATH.
const vendorDir = path.join(deployDir, 'vendor')
fs.renameSync(path.join(deployDir, 'node_modules'), vendorDir)
for (const entry of ['src', 'scripts', 'tsconfig.json', 'tsup.config.ts', 'vitest.config.ts']) {
  fs.rmSync(path.join(deployDir, entry), { recursive: true, force: true })
}
console.log(`✓ vendored deps: ${vendorDir}`)

// Bundle the Node runtime that runs the sidecar.
const runtimeDir = path.join(resources, 'runtime')
fs.mkdirSync(runtimeDir, { recursive: true })
const nodeDest = path.join(runtimeDir, 'node')
fs.copyFileSync(process.execPath, nodeDest)
fs.chmodSync(nodeDest, 0o755)
console.log(`✓ node runtime: ${nodeDest}`)

const webSrc = path.join(repoRoot, 'packages', 'web-app', 'dist')
const webDest = path.join(resources, 'web')
if (!fs.existsSync(path.join(webSrc, 'index.html'))) throw new Error('web dist missing; build failed')
fs.cpSync(webSrc, webDest, { recursive: true })

const corePackSrc = path.join(repoRoot, 'packages', 'core-pack')
const corePackDest = path.join(resources, 'packages', 'core-pack')
fs.mkdirSync(corePackDest, { recursive: true })
for (const entry of fs.readdirSync(corePackSrc)) {
  if (entry === 'node_modules' || entry === 'dist') continue
  fs.cpSync(path.join(corePackSrc, entry), path.join(corePackDest, entry), { recursive: true })
}

// Prove the bundled runtime can load the deployed native module and the SPA exists.
run(nodeDest, [
  '-e',
  [
    `const Database = require(${JSON.stringify(path.join(vendorDir, 'better-sqlite3'))});`,
    `const db = new Database(':memory:');`,
    `db.prepare('select 1 as x').get();`,
    `db.close();`,
    `console.log('sidecar runtime OK');`,
  ].join(''),
], resources)

for (const [label, file] of [
  ['server entry', path.join(deployDir, 'dist', 'index.js')],
  ['better-sqlite3', path.join(vendorDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')],
  ['node runtime', nodeDest],
  ['web index', path.join(webDest, 'index.html')],
  ['core-pack skills', path.join(corePackDest, 'skills')],
]) {
  if (!fs.existsSync(file)) throw new Error(`missing ${label}: ${file}`)
  console.log(`✓ ${label}: ${file}`)
}

console.log(`\nresources ready: ${resources}`)
