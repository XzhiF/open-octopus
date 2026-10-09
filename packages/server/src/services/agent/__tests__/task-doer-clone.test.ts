// packages/server/src/services/agent/__tests__/task-doer-clone.test.ts
//
// taskboard-modal-v2 ticket 01 — the task-doer built-in clone (ADR-0025).
//
// Seam: BUILTIN_CLONES / getBuiltinCloneDef / CloneInitService.initBuiltInClones
// (all public), observed via the CloneInitResult + filesystem state — same shape
// as clone-init-service.test.ts (paths mocked to a temp home; never the real
// ~/.octopus).
//
// Verifies (expectations lifted from spec/ticket/ADR, not from the implementation):
//   AC1a: task-doer is a registered built-in clone — 显示名「任务执行者」, isolated
//         memory, minimal declared skill set (工作区编辑 + 验证).
//   AC1b: setup lands it — built-in/task-doer/{persona.md, config.json,
//         memory/daily} created by initBuiltInClones (the inline-persona fallback
//         path the non-fork clones use — no seed fork for task-doer).
//   AC1c: the persona carries the ADR-0025 discipline — 每改即 commit（server 自动落
//         [quick-edit] 标记提交）、大改动劝退转修复轮是模型判断（persona 条文），
//         不改 spec 域。
//   AC1d: the built-in roster is 7 with task-doer appended (词条随实现更新 —
//         GLOSSARY-MAP 的「内置分身」条同步由本票改写)。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"

const MOCK_HOME = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-task-doer-${process.pid}`)
})

vi.mock('../paths', async () => {
  const p = require('path') as typeof import('path')
  const actual = await vi.importActual<typeof import('../paths')>('../paths')
  const builtInRoot = p.join(MOCK_HOME, 'agent', 'built-in')
  return {
    ...actual,
    getOctopusHome: () => MOCK_HOME,
    getAgentDir: () => p.join(MOCK_HOME, 'agent'),
    getBuiltInClonesDir: () => builtInRoot,
    getBuiltInCloneDir: (name: string) => p.join(builtInRoot, name),
    getBuiltInCloneMemoryDir: (name: string) => p.join(builtInRoot, name, 'memory'),
  }
})

import { BUILTIN_CLONES, getBuiltinCloneDef, isBuiltinClone } from '../builtin-clones'
import { CloneInitService } from '../clone-init-service'

// Stateful CloneDAO stand-in — DB registration itself is not under test, but the
// second-run skip needs find/insert to talk to each other (same posture as
// clone-init-service.test.ts's fakeDAO, minus the cross-run amnesia).
function fakeDAO() {
  const names = new Set<string>()
  return {
    findByName: (name: string) => (names.has(name) ? { name } : null),
    insert: (row: { name: string }) => {
      names.add(row.name)
      return {}
    },
  } as never
}

const doerDir = () => path.join(MOCK_HOME, 'agent', 'built-in', 'task-doer')

describe('task-doer built-in clone (ADR-0025)', () => {
  beforeAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  afterAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  it("AC1a: is registered with displayName 任务执行者, isolated memory, a minimal declared skill set", () => {
    expect(isBuiltinClone('task-doer')).toBe(true)
    const def = getBuiltinCloneDef('task-doer')
    expect(def).not.toBeNull()
    expect(def!.displayName).toBe('任务执行者')
    expect(def!.type).toBe('built-in')
    expect(def!.memoryScope).toBe('isolated')
    // 最小技能族（工作区编辑 + 验证）— declared intent (ADR-006: every clone
    // inherits shared skills; the list is auditable identity, not a filter).
    expect(def!.skills.length).toBeGreaterThan(0)
    expect(def!.skills.length).toBeLessThanOrEqual(3)
    expect(typeof def!.persona).toBe('string')
    expect(def!.persona.length).toBeGreaterThan(0)
  })

  it('AC1d: the built-in roster is exactly the 6 pre-existing clones + task-doer', () => {
    expect(BUILTIN_CLONES.map((c) => c.name)).toEqual([
      'workspace',
      'scheduler',
      'archive',
      'resource',
      'harness-agent',
      'task-author',
      'task-doer',
    ])
  })

  it('AC1b: setup lands persona.md + config.json + memory/ for task-doer', () => {
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO())

    expect(result.dirsCreated).toContain('built-in/task-doer')
    expect(result.dirsCreated).toContain('built-in/task-doer/memory')
    expect(result.dirsCreated).toContain('built-in/task-doer/memory/daily')
    expect(result.filesCreated).toContain('built-in/task-doer/persona.md')
    expect(result.filesCreated).toContain('built-in/task-doer/config.json')
    expect(result.dbRegistered).toContain('task-doer')

    // The landed persona is the registered one (inline fallback — no fork seed).
    expect(fs.readFileSync(path.join(doerDir(), 'persona.md'), 'utf-8'))
      .toBe(getBuiltinCloneDef('task-doer')!.persona)
    const config = JSON.parse(fs.readFileSync(path.join(doerDir(), 'config.json'), 'utf-8'))
    expect(config.name).toBe('task-doer')
    expect(config.display_name).toBe('任务执行者')
    expect(config.type).toBe('built-in')
  })

  it('AC1b: idempotent — a second setup does not rewrite the landed files', () => {
    const dao = fakeDAO()
    new CloneInitService().initBuiltInClones('test-org', dao)
    const second = new CloneInitService().initBuiltInClones('test-org', dao)

    expect(second.filesCreated).not.toContain('built-in/task-doer/persona.md')
    expect(second.filesSkipped).toContain('built-in/task-doer/persona.md')
    expect(second.dbRegistered).not.toContain('task-doer')
    expect(second.dbSkipped).toContain('task-doer')
  })

  it('AC1c: the persona carries the ADR-0025 discipline in canonical vocabulary', () => {
    const persona = getBuiltinCloneDef('task-doer')!.persona
    // 定位：接住 task-author 谈好的一切，在执行与验收期按人指令直接动执行分支。
    expect(persona).toContain('task-author')
    expect(persona).toContain('执行分支')
    // 快速修改写纪律：每改即 commit，server 落 [quick-edit] 标记，分身不必自行 commit。
    expect(persona).toContain('快速修改')
    expect(persona).toContain('[quick-edit]')
    // 大改动劝退 = 模型判断（persona 条文），出口是打回·修复轮 —— 不是关键词正则。
    expect(persona).toContain('修复轮')
    expect(persona).toContain('打回')
    // spec 域归作者/修复轮，doer 不改冻结规格。
    expect(persona).toContain('spec.md')
    // 与 harness 自动接管（agent_takeover）划清：这里是人工对话承接。
    expect(persona).toContain('人工接管')
  })
})
