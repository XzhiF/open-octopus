#!/usr/bin/env node
/**
 * Sync core-pack skills → .claude/skills/
 *
 * Runs after pnpm build to keep installed skill copies in sync
 * with the source-of-truth in packages/core-pack/skills/.
 */

import { readdirSync, cpSync, existsSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const source = join(root, 'packages', 'core-pack', 'skills')
const target = join(root, '.claude', 'skills')

if (!existsSync(source)) {
  console.log('[sync-skills] core-pack/skills/ not found, skipping')
  process.exit(0)
}

const skills = readdirSync(source).filter(name => {
  const skillDir = join(source, name)
  return statSync(skillDir).isDirectory() && existsSync(join(skillDir, 'SKILL.md'))
})

let synced = 0
for (const name of skills) {
  const src = join(source, name)
  const dst = join(target, name)
  cpSync(src, dst, { recursive: true, force: true })
  synced++
}

console.log(`[sync-skills] synced ${synced} skill(s) → .claude/skills/`)
