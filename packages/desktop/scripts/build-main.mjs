#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopDir, '..', '..')
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

const tsupCli = findStoreBin('tsup', 'dist/cli-default.js')
execFileSync(
  process.execPath,
  [
    tsupCli,
    'src/main.ts',
    'src/preload.ts',
    '--format',
    'cjs',
    '--out-dir',
    'dist',
    '--clean',
    '--external',
    'electron',
    '--target',
    'node20',
  ],
  { cwd: desktopDir, stdio: 'inherit' },
)
