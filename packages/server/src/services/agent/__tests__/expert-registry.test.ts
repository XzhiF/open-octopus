// packages/server/src/services/agent/__tests__/expert-registry.test.ts
//
// resolveExpertSubagents — resolves expert role ids into Claude SDK subagent
// defs by reading installed agent .md files (agency-agents-zh → core-pack
// fallback) or falling back to a minimal persona for unknown ids.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Isolate the resolver against a temp "home" so it never reads the developer's
// real installed agents. vi.hoisted runs before vi.mock factories, so
// expert-registry's module-level AGENTS_BASE sees the temp path.
const tmpHome = vi.hoisted(() => `/tmp/octopus-expert-reg-${Date.now()}`)

vi.mock('os', () => ({ default: { homedir: () => tmpHome } }))

import { resolveExpertSubagents } from '../expert-registry'

const AGENTS = path.join(tmpHome, '.octopus', 'resources', 'installed', 'agents')
const AGENCY = path.join(AGENTS, 'agency-agents-zh')
const CORE = path.join(AGENTS, 'core-pack')

const SAMPLE_MD = `---
name: 快速原型师
description: 专注超快速概念验证开发
emoji: ⚡
color: green
---
# 快速原型师 Agent 人格

你是快速原型师。
`

const SAMPLE_MD_WITH_TOOLS = `---
name: 前端开发者
description: 精通现代 Web 技术
tools: [Read, Grep, Glob, Bash]
---
# 前端开发者 Agent 人格
`

beforeEach(() => {
  mkdirSync(AGENCY, { recursive: true })
  mkdirSync(CORE, { recursive: true })
})

afterAll(() => {
  try {
    rmSync(path.join(tmpHome, '.octopus'), { recursive: true, force: true })
  } catch {
    // noop
  }
})

describe('resolveExpertSubagents', () => {
  it('resolves an agency-agents-zh agent file: body → prompt, frontmatter description, read-only default tools', () => {
    const dir = path.join(AGENCY, 'engineering-rapid-prototyper')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'engineering-rapid-prototyper.md'), SAMPLE_MD, 'utf-8')

    const result = resolveExpertSubagents([{ id: 'engineering-rapid-prototyper' }])
    expect(result).toBeDefined()
    const def = result!['engineering-rapid-prototyper']
    expect(def.description).toBe('专注超快速概念验证开发')
    // Frontmatter is stripped — persona body only, no `emoji`/`color` leaks.
    expect(def.prompt).toContain('你是快速原型师')
    expect(def.prompt).not.toContain('emoji')
    expect(def.prompt).not.toContain('color')
    // Consultation semantics: read-only tools by default.
    expect(def.tools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('falls back to core-pack/{id}.md when the agency dir is missing', () => {
    writeFileSync(path.join(CORE, 'engineering-frontend-developer.md'), SAMPLE_MD_WITH_TOOLS, 'utf-8')

    const result = resolveExpertSubagents([{ id: 'engineering-frontend-developer' }])
    expect(result).toBeDefined()
    const def = result!['engineering-frontend-developer']
    expect(def.prompt).toContain('前端开发者')
    // Frontmatter-declared tools are respected (not forced read-only).
    expect(def.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash'])
  })

  it('falls back to a minimal persona when no agent file exists', () => {
    const result = resolveExpertSubagents([{ id: 'ghost-expert', label: '幽灵专家' }])
    expect(result).toBeDefined()
    const def = result!['ghost-expert']
    expect(def.description).toBe('幽灵专家')
    expect(def.prompt).toContain('幽灵专家')
    expect(def.tools).toEqual(['Read', 'Grep', 'Glob'])
  })

  it('returns undefined for an empty or whitespace-only list', () => {
    expect(resolveExpertSubagents([])).toBeUndefined()
    expect(resolveExpertSubagents([{ id: '   ' }])).toBeUndefined()
  })

  it('skips blank ids and resolves the rest', () => {
    writeFileSync(path.join(CORE, 'agents-orchestrator.md'), SAMPLE_MD_WITH_TOOLS, 'utf-8')
    const result = resolveExpertSubagents([
      { id: '' },
      { id: 'agents-orchestrator' },
    ])
    expect(result).toBeDefined()
    expect(Object.keys(result!)).toEqual(['agents-orchestrator'])
  })
})
