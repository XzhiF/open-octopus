// packages/server/src/services/agent/__tests__/clone-init-service.test.ts
//
// goal-task-dev (ticket 05, AC3): workflow-presets.yaml seed migration.
//
// The old behavior was pure skip-if-exists (persona.md pattern): once seeded,
// the catalog NEVER refreshed — existing installs kept general-dev →
// matt-dev-pipeline forever and US1 (board default = task-dev) died silently.
// New behavior: file exists AND content (after normalizing the `# version: N`
// header) hashes to the embedded PREVIOUS default → refresh to the new default
// (+ log); user hand-edited → preserve (+ warn once per process);
// missing → write the new default.
//
// Seam: CloneInitService.initBuiltInClones() (public), observed via file state
// + CloneInitResult + console spies. Paths isolated via vi.mock('../paths')
// (init-service.test.ts convention) — never touches the real ~/.octopus.

import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// Isolated temp home for this suite
const MOCK_HOME = vi.hoisted(() => {
  const p = require('path') as typeof import('path')
  const o = require('os') as typeof import('os')
  return p.join(o.tmpdir(), `octopus-test-clone-init-${process.pid}`)
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

import { CloneInitService } from '../clone-init-service'
import {
  DEFAULT_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_WORKFLOW_PRESETS_YAML,
  PRESETS_VERSION,
} from '../workflow-presets-seed'

// Minimal CloneDAO stand-in — DB registration is not under test here.
const fakeDAO = {
  findByName: () => null,
  insert: () => ({}),
} as never

const PRESETS_REL_PATH = path.join('agent', 'built-in', 'task-author', 'workflow-presets.yaml')
const PRESETS_RESULT_KEY = 'built-in/task-author/workflow-presets.yaml'
const presetsPath = () => path.join(MOCK_HOME, PRESETS_REL_PATH)

function seedExistingFile(content: string): void {
  fs.mkdirSync(path.dirname(presetsPath()), { recursive: true })
  fs.writeFileSync(presetsPath(), content, 'utf-8')
}

describe('CloneInitService — workflow-presets.yaml seed migration (AC3)', () => {
  afterEach(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  it('refreshes an untouched old default to the new default and logs', () => {
    seedExistingFile(PREV_DEFAULT_WORKFLOW_PRESETS_YAML)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
      expect(result.filesRefreshed).toContain(PRESETS_RESULT_KEY)
      expect(result.filesSkipped).not.toContain(PRESETS_RESULT_KEY)
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(`v${PRESETS_VERSION}`),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('preserves a hand-edited catalog and warns exactly once per instance', () => {
    const handEdited = PREV_DEFAULT_WORKFLOW_PRESETS_YAML + '\n# my customization\n'
    seedExistingFile(handEdited)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const service = new CloneInitService()
      service.initBuiltInClones('test-org', fakeDAO)
      service.initBuiltInClones('test-org', fakeDAO) // second init must not re-warn

      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(handEdited)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('workflow-presets.yaml'),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('writes the new default when the file is missing', () => {
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
    expect(result.filesCreated).toContain(PRESETS_RESULT_KEY)
  })

  it('leaves an already-current catalog untouched without warn (idempotent)', () => {
    seedExistingFile(DEFAULT_WORKFLOW_PRESETS_YAML)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
      expect(result.filesSkipped).toContain(PRESETS_RESULT_KEY)
      expect(result.filesRefreshed).not.toContain(PRESETS_RESULT_KEY)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('refreshes even when the editor appended a trailing blank line to the old default', () => {
    // Normalization (trimEnd + version-header strip) must not let whitespace
    // drift flip an unmodified seed into "user-modified" — otherwise every
    // editor-touching user silently opts out of future seed migrations.
    seedExistingFile(PREV_DEFAULT_WORKFLOW_PRESETS_YAML + '\n\n')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(result.filesRefreshed).toContain(PRESETS_RESULT_KEY)
      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
    } finally {
      logSpy.mockRestore()
    }
  })
})
