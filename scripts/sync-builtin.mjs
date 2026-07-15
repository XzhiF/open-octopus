#!/usr/bin/env node
/**
 * Sync core-pack built-in resources → local targets
 *
 * - skills/    → .claude/skills/
 * - agents/    → .claude/agents/
 * - workflow-schema.json → ~/.octopus/workflow-schema.json
 *
 * Runs after pnpm build to keep local copies in sync
 * with the source-of-truth in packages/core-pack/.
 */

import { readdirSync, cpSync, existsSync, statSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const corePack = join(root, 'packages', 'core-pack')

function syncDir(srcDir, dstDir, filter) {
  if (!existsSync(srcDir)) return 0
  mkdirSync(dstDir, { recursive: true })
  const entries = readdirSync(srcDir).filter(filter ?? (() => true))
  let count = 0
  for (const name of entries) {
    const src = join(srcDir, name)
    const dst = join(dstDir, name)
    if (statSync(src).isDirectory()) {
      cpSync(src, dst, { recursive: true, force: true })
    } else {
      cpSync(src, dst, { force: true })
    }
    count++
  }
  return count
}

// Skills: directories containing SKILL.md
const skillsSrc = join(corePack, 'skills')
const skillsDst = join(root, '.claude', 'skills')
const skillCount = syncDir(skillsSrc, skillsDst, name => {
  return statSync(join(skillsSrc, name)).isDirectory() &&
    existsSync(join(skillsSrc, name, 'SKILL.md'))
})

// Agents: .md files (role cards)
const agentsSrc = join(corePack, 'agents')
const agentsDst = join(root, '.claude', 'agents')
const agentCount = syncDir(agentsSrc, agentsDst, name => {
  return name.endsWith('.md') && !name.endsWith('.tpl')
})

// Schema: workflow-schema.json → ~/.octopus/
const schemaSrc = join(corePack, 'workflows', 'workflow-schema.json')
if (existsSync(schemaSrc)) {
  const globalSchemaDst = join(homedir(), '.octopus', 'workflow-schema.json')
  mkdirSync(dirname(globalSchemaDst), { recursive: true })
  cpSync(schemaSrc, globalSchemaDst, { force: true })
}

console.log(
  `[sync-builtin] skills: ${skillCount}, agents: ${agentCount}, schema: ${existsSync(schemaSrc) ? '✓' : '✗'}`
)
