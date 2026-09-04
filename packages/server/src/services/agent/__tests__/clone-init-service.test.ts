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

import { CloneInitService, MATT_SKILL_FAMILY } from '../clone-init-service'
import {
  DEFAULT_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML,
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

  it('refreshes an untouched old default (v1b) to the new default and logs', () => {
    seedExistingFile(PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML)

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
    const handEdited = PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML + '\n# my customization\n'
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

  it('refreshes an install seeded from the EARLIER v1a literal (pre-superpowers) — code-review c1', () => {
    // v1a shipped before the superpowers preset was appended mid-life. A single
    // PREV baseline would hash-miss it → false "user-modified" → never
    // refreshed. Every historical default must be recognized.
    seedExistingFile(PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
      expect(result.filesRefreshed).toContain(PRESETS_RESULT_KEY)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('refreshes even when the editor appended a trailing blank line to the old default', () => {
    // Normalization (trimEnd + version-header strip) must not let whitespace
    // drift flip an unmodified seed into "user-modified" — otherwise every
    // editor-touching user silently opts out of future seed migrations.
    seedExistingFile(PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML + '\n\n')

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

// ── ticket 09 (task-phase-redesign, K15/AC1): matt skill-family seed ────
//
// The matt spec-drafting family (matt-verified-*/domain-modeling/grilling/
// wayfinder) is seeded into built-in/task-author/skills/ so the task-author
// clone session's SDK plugin scan picks it up with ZERO per-session code
// (getPlugins already returns the clone dir — clone-runtime.test.ts pins that;
// what this suite pins is that skills/ actually lands there). Source = the
// repo's own .claude/skills/ (same copy-if-missing + skip-if-exists mechanism
// as init-service.copyBuiltinSkills — no new directory convention).

const SKILLS_REL = path.join('agent', 'built-in', 'task-author', 'skills')
const skillsDest = (skill: string) => path.join(MOCK_HOME, SKILLS_REL, skill)

describe('CloneInitService — matt skill-family seed (ticket 09 / AC1)', () => {
  afterEach(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  it('seeds every matt-family skill dir with SKILL.md into task-author/skills/', () => {
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(MATT_SKILL_FAMILY.length).toBeGreaterThanOrEqual(5)
    for (const skill of MATT_SKILL_FAMILY) {
      expect(
        fs.existsSync(path.join(skillsDest(skill), 'SKILL.md')),
        `expected seeded SKILL.md for ${skill}`,
      ).toBe(true)
      expect(result.filesCreated).toContain(`built-in/task-author/skills/${skill}`)
    }
    // auxiliary files ride along (not just SKILL.md)
    expect(
      fs.existsSync(
        path.join(skillsDest('matt-verified-requirement'), 'references', 'story-walkthrough.md'),
      ),
    ).toBe(true)
    expect(
      fs.existsSync(path.join(skillsDest('domain-modeling'), 'ADR-FORMAT.md')),
    ).toBe(true)
  })

  it('is idempotent — second init skips existing skills without rewriting', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    // simulate a user edit after first seed
    const edited = '# my customized grilling\n'
    const editedFile = path.join(skillsDest('grilling'), 'SKILL.md')
    fs.writeFileSync(editedFile, edited, 'utf-8')

    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.readFileSync(editedFile, 'utf-8')).toBe(edited) // skip-if-exists preserves edits
    for (const skill of MATT_SKILL_FAMILY) {
      expect(result.filesCreated).not.toContain(`built-in/task-author/skills/${skill}`)
      expect(result.filesSkipped).toContain(`built-in/task-author/skills/${skill}`)
    }
  })

  it('does NOT seed matt skills for non task-author clones', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    const schedulerSkills = path.join(MOCK_HOME, 'agent', 'built-in', 'scheduler', 'skills')
    if (fs.existsSync(schedulerSkills)) {
      for (const skill of MATT_SKILL_FAMILY) {
        expect(fs.existsSync(path.join(schedulerSkills, skill))).toBe(false)
      }
    } // else: no skills dir created for scheduler — also correct
  })
})
