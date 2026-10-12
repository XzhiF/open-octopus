// packages/server/src/services/agent/__tests__/workflow-operator-clone.test.ts
//
// LLM-WIKI P1 ticket 09 — workflow-operator, the 8th built-in clone (the default
// execution identity for workflow agent nodes, spec §执行身份).
//
// Seams: BUILTIN_CLONES / getBuiltinCloneDef / isBuiltinClone (registry),
// CloneInitService.initBuiltInClones (DB + filesystem dual-track, idempotent),
// listAllClones (clone list visibility), publishVersionedBuiltinClones +
// VersionResolver (agent_versions initial publish → snapshot-resolvable, pin-able).
// Paths are steered with OCTOPUS_HOME (the agent-version.test.ts pattern) — never
// the real ~/.octopus.
//
// Expected persona/config literals are quoted from the prototype
// (llm-wiki-notes/prototype.md, Tab④ persona/config 骨架) — an independent source
// of truth, not re-derived from the implementation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import { VersionResolver } from '@octopus/shared'

import { BUILTIN_CLONES, getBuiltinCloneDef, isBuiltinClone } from '../builtin-clones'
import { isValidCloneName, listAllClones, deleteUserClone } from '../clone-resolver'
import { CloneInitService } from '../clone-init-service'
import { AgentVersionDAO } from '../../../db/dao/agent-version-dao'
import { publishVersionedBuiltinClones, INITIAL_BUILTIN_VERSION } from '../agent-version-service'
import { WORKFLOW_OPERATOR_CLONE_NAME } from '@octopus/shared'

// ── Prototype skeleton (Tab④, lines 663-684) — verbatim, hard line-wraps joined ──

const PROTOTYPE_ROLE_LINE = '你是工作流执行工程师，代表 Octopus 在工作流 agent 节点中执行任务。'
const PROTOTYPE_GUIDELINE_HEADER = '## 行为准则'
/** 四条行为准则（prototype Tab④ persona 骨架逐字；换行折行按原文顺序拼回单行）。 */
const PROTOTYPE_GUIDELINES = [
  '动手前先经 octo-wiki 查阅相关知识，有参考地执行；引用写入 wiki_refs',
  'cwd 是任务工作现场，遵守其 CLAUDE.md',
  '你无人格特权：安全规则 > 任务书 > 知识参考',
  '知识冲突时以现场代码为准，并上报 stale',
] as const

describe('workflow-operator built-in clone (LLM-WIKI ticket 09)', () => {
  it('is registered as a built-in clone with a schema-legal name, display name 工作流工程师', () => {
    expect(isBuiltinClone('workflow-operator')).toBe(true)
    // 英文代号符合 /^[a-z0-9-]+$/（clone 名安全闸，同其余 7 个）
    expect(isValidCloneName(WORKFLOW_OPERATOR_CLONE_NAME)).toBe(true)
    expect(WORKFLOW_OPERATOR_CLONE_NAME).toBe('workflow-operator')

    const def = getBuiltinCloneDef('workflow-operator')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('workflow-operator')
    expect(def!.displayName).toBe('工作流工程师')
    expect(def!.type).toBe('built-in')
    // 执行期记忆与主 agent daily 隔离（原型 config.json 骨架 memoryScope 语义的 CloneDef 承载位）
    expect(def!.memoryScope).toBe('isolated')
  })

  it('persona carries the prototype role line + the four 行为准则 verbatim', () => {
    const persona = getBuiltinCloneDef('workflow-operator')!.persona
    expect(persona).toContain(PROTOTYPE_ROLE_LINE)
    expect(persona).toContain(PROTOTYPE_GUIDELINE_HEADER)
    for (const guideline of PROTOTYPE_GUIDELINES) {
      expect(persona).toContain(guideline)
    }
  })

  it('config declares governance skills [octo-wiki] + the version marker', () => {
    const def = getBuiltinCloneDef('workflow-operator')!
    // ADR-0006: skills 是治理语义 + preflight 依据，不是运行时发现机制（票 11 走 Provisioner）。
    expect(def.skills).toEqual(['octo-wiki'])
    // versioned=true → 启动时初始 agent_versions 发布（工作流可钉版本）
    expect(def.config.versioned).toBe(true)
  })

  it('is the 8th entry appended to the registry roster', () => {
    expect(BUILTIN_CLONES).toHaveLength(8)
    expect(BUILTIN_CLONES[7].name).toBe('workflow-operator')
  })
})

// ── CloneInitService dual-track (DB + filesystem) + list visibility ──

// Stateful CloneDAO stand-in (same posture as task-doer-clone.test.ts): the
// second-run skip needs find/insert to talk to each other; DB internals are not
// under test here.
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

const operatorDir = () => path.join(process.env.OCTOPUS_HOME!, 'agent', 'built-in', 'workflow-operator')

describe('workflow-operator lands via CloneInitService dual-track (ticket 09)', () => {
  const TEST_DIR = path.join(os.tmpdir(), `octopus-wf-operator-init-${process.pid}`)

  beforeEach(() => {
    process.env.OCTOPUS_HOME = TEST_DIR
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true })
    } catch {
      // Cleanup failure is non-fatal in tests
    }
  })

  it('filesystem track: persona.md + config.json + memory/daily land under built-in/workflow-operator', () => {
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO())

    expect(result.dirsCreated).toContain('built-in/workflow-operator')
    expect(result.dirsCreated).toContain('built-in/workflow-operator/memory')
    expect(result.dirsCreated).toContain('built-in/workflow-operator/memory/daily')
    expect(result.filesCreated).toContain('built-in/workflow-operator/persona.md')
    expect(result.filesCreated).toContain('built-in/workflow-operator/config.json')
    expect(result.dbRegistered).toContain('workflow-operator')

    // Inline-persona fallback (no fork seed for this clone): the landed persona
    // is the registered one — the prototype 准则 survive the round-trip to disk.
    expect(fs.readFileSync(path.join(operatorDir(), 'persona.md'), 'utf-8'))
      .toContain(PROTOTYPE_GUIDELINES[0])
    expect(fs.readFileSync(path.join(operatorDir(), 'persona.md'), 'utf-8'))
      .toBe(getBuiltinCloneDef('workflow-operator')!.persona)

    const config = JSON.parse(fs.readFileSync(path.join(operatorDir(), 'config.json'), 'utf-8'))
    expect(config.name).toBe('workflow-operator')
    expect(config.display_name).toBe('工作流工程师')
    expect(config.type).toBe('built-in')
    expect(config.skills).toEqual(['octo-wiki'])
    expect(config.memoryScope).toBe('isolated')
    // version marker persists into config.json — the publish step reads it there.
    expect(config.config.versioned).toBe(true)
  })

  it('idempotent: a second init neither rewrites the landed files nor registers a duplicate', () => {
    const dao = fakeDAO()
    new CloneInitService().initBuiltInClones('test-org', dao)
    const second = new CloneInitService().initBuiltInClones('test-org', dao)

    expect(second.dirsCreated).not.toContain('built-in/workflow-operator')
    expect(second.filesCreated).not.toContain('built-in/workflow-operator/persona.md')
    expect(second.filesCreated).not.toContain('built-in/workflow-operator/config.json')
    expect(second.filesSkipped).toContain('built-in/workflow-operator/persona.md')
    expect(second.filesSkipped).toContain('built-in/workflow-operator/config.json')
    expect(second.dbRegistered).not.toContain('workflow-operator')
    expect(second.dbSkipped).toContain('workflow-operator')
  })

  it('clone list shows workflow-operator and it stays non-deletable like the other 7', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO())

    const row = listAllClones().find((c) => c.name === 'workflow-operator')
    expect(row).toBeDefined()
    expect(row!.display_name).toBe('工作流工程师')
    expect(row!.type).toBe('built-in')

    // 不可删除：built-in 删除闸（deleteUserClone 经 isBuiltinClone 拦截）
    const del = deleteUserClone('workflow-operator')
    expect(del.ok).toBe(false)
  })
})

// ── agent_versions initial publish + snapshot resolution ──

// Minimal schema mirroring agent-version.test.ts's setupTestDb (agent_versions +
// clones — publish's updateCloneVersionId touches the latter).
function setupTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      version TEXT NOT NULL,
      major INTEGER NOT NULL,
      minor INTEGER NOT NULL,
      patch INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'stable',
      status TEXT NOT NULL DEFAULT 'draft',
      snapshot TEXT NOT NULL,
      changelog TEXT,
      published_at TEXT,
      published_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(agent_name, version)
    );
    CREATE TABLE IF NOT EXISTS clones (
      name TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT 'default',
      type TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      persona TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]',
      workspace_ref TEXT NOT NULL DEFAULT '{}',
      memory_scope TEXT NOT NULL DEFAULT 'isolated',
      last_active_at TEXT,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  return db
}

describe('workflow-operator agent_versions publish + resolvable snapshot (ticket 09)', () => {
  const TEST_DIR = path.join(os.tmpdir(), `octopus-wf-operator-pub-${process.pid}`)
  let db: Database.Database

  beforeEach(() => {
    process.env.OCTOPUS_HOME = TEST_DIR
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    db = setupTestDb()
    // Land the filesystem track first — publish snapshots built-in/workflow-operator/.
    new CloneInitService().initBuiltInClones('test-org', fakeDAO())
  })

  afterEach(() => {
    delete process.env.OCTOPUS_HOME
    try { db.close() } catch { /* non-fatal */ }
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
  })

  it('publishes exactly the versioned built-in (workflow-operator) at the initial version, dual-write DB + FS', () => {
    const dao = new AgentVersionDAO(db)
    const published = publishVersionedBuiltinClones(dao)

    // Only clones with config.versioned get seeded — the other 7 are untouched.
    expect(published).toEqual(['workflow-operator'])

    const row = dao.findByAgentAndVersion('workflow-operator', INITIAL_BUILTIN_VERSION)
    expect(row).not.toBeNull()
    expect(row!.status).toBe('published')
    expect(row!.stage).toBe('stable')

    // The published snapshot IS the landed identity: persona keeps the prototype
    // 准则 and config keeps the octo-wiki governance declaration.
    const snapshot = JSON.parse(row!.snapshot) as { persona: string; config: Record<string, unknown>; skills: string[] }
    for (const guideline of PROTOTYPE_GUIDELINES) {
      expect(snapshot.persona).toContain(guideline)
    }
    expect(snapshot.config.name).toBe('workflow-operator')
    expect(snapshot.config.skills).toEqual(['octo-wiki'])

    // FS track: versions/workflow-operator/{version}/persona.md landed.
    expect(fs.existsSync(path.join(TEST_DIR, 'agent', 'versions', 'workflow-operator', INITIAL_BUILTIN_VERSION, 'persona.md'))).toBe(true)
  })

  it('idempotent: re-running the seed publishes no duplicate', () => {
    const dao = new AgentVersionDAO(db)
    publishVersionedBuiltinClones(dao)
    const second = publishVersionedBuiltinClones(dao)

    expect(second).toEqual([])
    expect(dao.listAllPublished().filter((v) => v.agent_name === 'workflow-operator')).toHaveLength(1)
  })

  it('the existing octopus_agent snapshot mechanism resolves it — latest AND pinned', () => {
    const dao = new AgentVersionDAO(db)
    publishVersionedBuiltinClones(dao)

    // Same construction as EngineFactory: VersionResolver over listAllPublished().
    // (Ticket 08's IdentityResolver is not merged yet; this is the resolution
    // proof against the existing published-snapshot path.)
    const resolver = new VersionResolver(dao.listAllPublished())

    const latest = resolver.resolve('workflow-operator', 'latest')
    expect(latest.version).toBe(INITIAL_BUILTIN_VERSION)
    expect(latest.snapshot.persona).toContain(PROTOTYPE_ROLE_LINE)
    expect(latest.snapshot.config.skills).toEqual(['octo-wiki'])

    // 工作流可钉住版本（票 09 "可被工作流钉住版本"）：
    const pinned = resolver.resolve('workflow-operator', INITIAL_BUILTIN_VERSION)
    expect(pinned.snapshot.persona).toBe(latest.snapshot.persona)
  })
})
