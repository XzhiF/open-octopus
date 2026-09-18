// packages/server/src/services/agent/__tests__/clone-init-service.test.ts
//
// Two seeds live in CloneInitService, each with its own migration story:
//
// 1. **workflow-presets.yaml** (goal-task-dev ticket 05, AC3) — the old
//    behavior was pure skip-if-exists: once seeded the catalog NEVER refreshed,
//    so existing installs kept general-dev → matt-dev-pipeline forever and US1
//    (board default = task-dev) died silently. New behavior: content (after
//    normalizing the `# version: N` header) hashing to ANY historical embedded
//    default → refresh (+ log); hand-edited → preserve (+ warn once).
//
// 2. **task-author clone assets** (persona.md + the whole skills/ tree) — the
//    same class of bug, worse blast radius. The skills were copied once from
//    the repo's shared `.claude/skills/` and never refreshed, so installs were
//    stranded on copies missing later discipline (e.g. author-verified-tickets
//    without Rule 5's browser-dedup ladder). They now come from the fork at
//    packages/core-pack/clones/task-author/ with a `.seed-manifest.json`
//    recording each file's sha256, so an untouched file upgrades and a
//    hand-edited one is preserved.
//
// Seam: CloneInitService.initBuiltInClones() (public), observed via file state
// + CloneInitResult + console spies. Paths isolated via vi.mock('../paths')
// (init-service.test.ts convention) — never touches the real ~/.octopus.
//
// The clone-assets suite drives its own temp SOURCE tree through
// OCTOPUS_TASK_AUTHOR_SEED_DIR, so it can exercise a real upstream upgrade
// (source changes) rather than faking one.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

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

import {
  CloneInitService,
  MATT_SKILL_FAMILY,
  TASK_AUTHOR_SEED_MANIFEST,
  collectSeedFiles,
  findTaskAuthorSeedDir,
} from '../clone-init-service'
import {
  DEFAULT_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1A_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V1B_WORKFLOW_PRESETS_YAML,
  PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML,
  PRESETS_VERSION,
} from '../workflow-presets-seed'
import { BUILTIN_CLONES } from '../builtin-clones'

// Minimal CloneDAO stand-in — DB registration is not under test here.
const fakeDAO = {
  findByName: () => null,
  insert: () => ({}),
} as never

const PRESETS_REL_PATH = path.join('agent', 'built-in', 'task-author', 'workflow-presets.yaml')
const PRESETS_RESULT_KEY = 'built-in/task-author/workflow-presets.yaml'
const presetsPath = () => path.join(MOCK_HOME, PRESETS_REL_PATH)

/** console.warn calls that are about the presets catalog specifically. The
 *  clone-assets seed has its own warn channel (it runs in the same init), so
 *  assertions here must filter rather than count all warns. */
function presetsWarns(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(
    (c) => typeof c[0] === 'string' && c[0].includes('workflow-presets.yaml'),
  )
}

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
      expect(presetsWarns(warnSpy)).toHaveLength(1)
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
      expect(presetsWarns(warnSpy)).toHaveLength(0)
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
      expect(presetsWarns(warnSpy)).toHaveLength(0)
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

  it('refreshes an untouched v2 seed to the v3 binding catalog', () => {
    // binding-catalog redesign (2026-09-06): v2 (skills_group shape) joins the
    // PREV baselines — an untouched v2 install must land on the new catalog
    // (spec-dev → built-in/matt-spec-dev), not keep offering retired flows.
    seedExistingFile(PREV_DEFAULT_V2_WORKFLOW_PRESETS_YAML)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(fs.readFileSync(presetsPath(), 'utf-8')).toBe(DEFAULT_WORKFLOW_PRESETS_YAML)
      expect(result.filesRefreshed).toContain(PRESETS_RESULT_KEY)
      expect(DEFAULT_WORKFLOW_PRESETS_YAML).toContain('built-in/matt-spec-dev')
      expect(DEFAULT_WORKFLOW_PRESETS_YAML).toContain('batch_dir')
    } finally {
      logSpy.mockRestore()
    }
  })
})

// ── task-author clone assets: persona.md + skills/ (fork + manifest) ────

const CLONE_REL = path.join('agent', 'built-in', 'task-author')
const cloneDir = () => path.join(MOCK_HOME, CLONE_REL)
const destOf = (rel: string) => path.join(cloneDir(), rel)
const manifestPath = () => destOf(TASK_AUTHOR_SEED_MANIFEST)

/** Temp SOURCE tree standing in for packages/core-pack/clones/task-author/,
 *  so the suite can change the source between inits and drive a real upgrade. */
const SRC = path.join(os.tmpdir(), `octopus-test-ta-seed-src-${process.pid}`)

function writeSource(rel: string, content: string): void {
  const abs = path.join(SRC, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf-8')
}

/** A source minimally shaped like the real fork: persona + one skill dir with
 *  an aux file. */
function buildSource(files: Record<string, string> = {}): void {
  fs.rmSync(SRC, { recursive: true, force: true })
  writeSource('persona.md', '# Task-Author\n\nv1\n')
  writeSource('skills/grilling/SKILL.md', '# grilling v1\n')
  writeSource('skills/grilling/agents/openai.yaml', 'name: grilling\n')
  for (const [rel, content] of Object.entries(files)) writeSource(rel, content)
}

/** Retire a skill from the source tree — the rename/migration shape the
 *  orphan sweep exists for. */
function retireFromSource(skill: string): void {
  fs.rmSync(path.join(SRC, 'skills', skill), { recursive: true, force: true })
}

describe('CloneInitService — task-author clone assets seed', () => {
  beforeEach(() => {
    buildSource()
    process.env.OCTOPUS_TASK_AUTHOR_SEED_DIR = SRC
  })

  afterEach(() => {
    delete process.env.OCTOPUS_TASK_AUTHOR_SEED_DIR
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
    fs.rmSync(SRC, { recursive: true, force: true })
  })

  it('honours the source override so tests never read the real fork', () => {
    expect(findTaskAuthorSeedDir()).toBe(SRC)
  })

  it('seeds persona.md and the whole skills/ tree, aux files included', () => {
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.readFileSync(destOf('persona.md'), 'utf-8')).toBe('# Task-Author\n\nv1\n')
    expect(fs.readFileSync(destOf('skills/grilling/SKILL.md'), 'utf-8')).toBe('# grilling v1\n')
    // aux files ride along — whole-tree copy, not just SKILL.md
    expect(fs.existsSync(destOf('skills/grilling/agents/openai.yaml'))).toBe(true)
    expect(result.filesCreated).toContain('built-in/task-author/persona.md')
    expect(result.filesCreated).toContain('built-in/task-author/skills/grilling/SKILL.md')
  })

  it('writes the manifest so the NEXT run can tell edits from staleness', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'))
    expect(Object.keys(manifest.files).sort()).toEqual([
      'persona.md',
      'skills/grilling/SKILL.md',
      'skills/grilling/agents/openai.yaml',
    ])
    // hashes, not contents — the manifest must not bloat with file bodies
    expect(manifest.files['persona.md']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent — a second run with an unchanged source rewrites nothing', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(result.filesCreated).not.toContain('built-in/task-author/persona.md')
    expect(result.filesRefreshed).not.toContain('built-in/task-author/persona.md')
    expect(result.filesSkipped).toContain('built-in/task-author/persona.md')
  })

  it('UPGRADES an untouched file when the source moves forward', () => {
    // The whole point of the manifest: a file the user never touched must pick
    // up upstream changes. This is the bug that stranded installs on stale
    // skills — the regression guard for it.
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    writeSource('skills/grilling/SKILL.md', '# grilling v2 — new discipline\n')
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.readFileSync(destOf('skills/grilling/SKILL.md'), 'utf-8'))
      .toBe('# grilling v2 — new discipline\n')
    expect(result.filesRefreshed).toContain('built-in/task-author/skills/grilling/SKILL.md')
  })

  it('PRESERVES a hand-edited file and warns once per process', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)
    const edit = '# my own grilling notes\n'
    fs.writeFileSync(destOf('skills/grilling/SKILL.md'), edit, 'utf-8')

    writeSource('skills/grilling/SKILL.md', '# grilling v2\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const service = new CloneInitService()
      service.initBuiltInClones('test-org', fakeDAO)
      service.initBuiltInClones('test-org', fakeDAO) // must not re-warn

      expect(fs.readFileSync(destOf('skills/grilling/SKILL.md'), 'utf-8')).toBe(edit)
      const own = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('user-modified'),
      )
      expect(own).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('backs up pre-versioning assets before the first managed seed', () => {
    // An install seeded before the manifest existed cannot tell a stale seed
    // from a hand-edit. It gets taken over wholesale — with a backup, which is
    // the only safety net for whatever the user had.
    fs.mkdirSync(path.join(cloneDir(), 'skills', 'grilling'), { recursive: true })
    fs.writeFileSync(destOf('persona.md'), '# my precious hand-written persona\n', 'utf-8')
    fs.writeFileSync(destOf('skills/grilling/SKILL.md'), '# my precious grilling\n', 'utf-8')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      const backup = fs.readdirSync(cloneDir()).find((n) => n.startsWith('seed.bak-'))
      expect(backup, 'a seed.bak-<ts>/ dir must exist').toBeDefined()
      expect(
        fs.readFileSync(path.join(cloneDir(), backup!, 'persona.md'), 'utf-8'),
      ).toBe('# my precious hand-written persona\n')
      expect(
        fs.readFileSync(path.join(cloneDir(), backup!, 'skills', 'grilling', 'SKILL.md'), 'utf-8'),
      ).toBe('# my precious grilling\n')
      // and the takeover did land
      expect(fs.readFileSync(destOf('persona.md'), 'utf-8')).toBe('# Task-Author\n\nv1\n')
      expect(result.filesRefreshed).toContain('built-in/task-author/persona.md')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('restores a deleted file (delete-to-re-seed is the documented escape)', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)
    fs.rmSync(destOf('skills/grilling/SKILL.md'))

    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.existsSync(destOf('skills/grilling/SKILL.md'))).toBe(true)
  })

  // ── orphan sweep: the rename-migration path ─────────────────────────
  // The real trigger: matt-verified-* → author-verified-*. A renamed skill
  // whose untouched old copy survives seeding would stay discoverable under
  // the retired name (SDK reads frontmatter `name` across the whole tree),
  // colliding with the project-level skill it was forked away from.

  it('removes an untouched orphan whose source is gone, prunes its empty dirs', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    // The fork renames the skill (grilling retires, author-verified-requirement
    // takes over).
    buildSource({ 'skills/author-verified-requirement/SKILL.md': '# author-verified-requirement v1\n' })
    retireFromSource('grilling')
    const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.existsSync(destOf('skills/grilling/SKILL.md'))).toBe(false)
    expect(fs.existsSync(destOf('skills/grilling'))).toBe(false) // no empty shell
    expect(fs.existsSync(destOf('skills/author-verified-requirement/SKILL.md'))).toBe(true)
    expect(result.filesRefreshed).toContain('built-in/task-author/skills/grilling/SKILL.md')
    expect(result.filesCreated).toContain('built-in/task-author/skills/author-verified-requirement/SKILL.md')
    // The retired name is gone from the manifest too — the next run must not
    // resurrect it.
    const manifest = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'))
    expect(Object.keys(manifest.files)).not.toContain('skills/grilling/SKILL.md')
  })

  it('keeps a hand-edited orphan and warns once; removes its untouched sibling', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)
    fs.writeFileSync(destOf('skills/grilling/SKILL.md'), '# my own grilling notes\n', 'utf-8')

    buildSource()
    retireFromSource('grilling')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      // hand-edited orphan → user's file, kept + warned exactly once
      expect(fs.readFileSync(destOf('skills/grilling/SKILL.md'), 'utf-8'))
        .toBe('# my own grilling notes\n')
      // untouched orphan aux file under the same retired skill → removed, but
      // the dir survives because the kept file still lives in it
      expect(fs.existsSync(destOf('skills/grilling/agents/openai.yaml'))).toBe(false)
      const own = warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('user-modified'),
      )
      expect(own).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('forgets an orphan the user already deleted (no warn, nothing recreated)', () => {
    buildSource({ 'skills/wayfinder/SKILL.md': '# wayfinder v1\n' })
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)
    fs.rmSync(destOf('skills/wayfinder/SKILL.md'))

    retireFromSource('wayfinder') // fork retires it
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = new CloneInitService().initBuiltInClones('test-org', fakeDAO)

      expect(fs.existsSync(destOf('skills/wayfinder/SKILL.md'))).toBe(false)
      expect(result.filesCreated).not.toContain('built-in/task-author/skills/wayfinder/SKILL.md')
      expect(result.filesRefreshed).not.toContain('built-in/task-author/skills/wayfinder/SKILL.md')
      expect(warnSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('user-modified'),
      )).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('never deletes on a pre-versioning takeover — the backup is the safety net', () => {
    // No manifest → no recorded sha → cannot tell stale seed from hand-edit,
    // so the sweep is inert; the old copy is taken over, not removed (and
    // preserved in seed.bak-<ts>/).
    fs.mkdirSync(path.join(cloneDir(), 'skills', 'grilling'), { recursive: true })
    fs.writeFileSync(destOf('skills/grilling/SKILL.md'), '# pre-versioning copy\n', 'utf-8')

    buildSource({ 'skills/wayfinder/SKILL.md': '# wayfinder v1\n' })
    retireFromSource('grilling') // retired in the fork — but sweep stays inert without a manifest
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.readFileSync(destOf('skills/grilling/SKILL.md'), 'utf-8')).toBe('# pre-versioning copy\n')
  })

  it('does NOT touch assets for other clones', () => {
    new CloneInitService().initBuiltInClones('test-org', fakeDAO)

    expect(fs.existsSync(path.join(MOCK_HOME, 'agent', 'built-in', 'scheduler', 'skills', 'grilling')))
      .toBe(false)
  })
})

describe('task-author fork — shape of the shipped source', () => {
  // These run against the REAL fork (no OCTOPUS_TASK_AUTHOR_SEED_DIR override),
  // so the checked-in asset tree cannot silently drift out of contract.
  const realFork = path.resolve(__dirname, '../../../../../core-pack/clones/task-author')

  it('resolves the repo fork when no override is set', () => {
    delete process.env.OCTOPUS_TASK_AUTHOR_SEED_DIR
    expect(findTaskAuthorSeedDir()).toBe(realFork)
  })

  it('ships exactly the declared skill family', () => {
    const dirs = fs
      .readdirSync(path.join(realFork, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect(dirs).toEqual([...MATT_SKILL_FAMILY].sort())
  })

  it('ships a SKILL.md in every family dir, plus the aux files that ride along', () => {
    for (const skill of MATT_SKILL_FAMILY) {
      expect(
        fs.existsSync(path.join(realFork, 'skills', skill, 'SKILL.md')),
        `missing SKILL.md for ${skill}`,
      ).toBe(true)
    }
    expect(
      fs.existsSync(path.join(realFork, 'skills/author-verified-requirement/references/story-walkthrough.md')),
    ).toBe(true)
    expect(fs.existsSync(path.join(realFork, 'skills/domain-modeling/ADR-FORMAT.md'))).toBe(true)
  })

  it('collectSeedFiles walks the tree and covers persona + skills', () => {
    const files = collectSeedFiles(realFork, ['persona.md', 'skills'])
    expect(files).toContain('persona.md')
    expect(files).toContain('skills/grilling/SKILL.md')
    // posix-normalized, so the manifest keys are stable across platforms
    expect(files.every((f) => !f.includes('\\'))).toBe(true)
  })

  it('the fork carries NO execution-pipeline exits (the reason it is a fork)', () => {
    // If the shared copies gain something that must not reach the author view,
    // this is where it should fail rather than in a live drafting session.
    const requirement = fs.readFileSync(
      path.join(realFork, 'skills/author-verified-requirement/SKILL.md'),
      'utf-8',
    )
    expect(requirement).not.toContain('Execution Decisions Gate')
    expect(requirement).not.toContain('Two options to proceed')
    // The ban is stated, not merely implied.
    expect(requirement).toContain('This is where your job ends')

    const persona = fs.readFileSync(path.join(realFork, 'persona.md'), 'utf-8')
    expect(persona).toContain('禁止执行开发')
    // ...and the retired endpoint it used to teach is gone
    expect(persona).not.toContain('/jobs/:id/enqueue')
  })
})

describe('persona.md ↔ builtin-clones.ts consistency', () => {
  // persona.md is authoritative (loadPersona reads the file first); the
  // TASK_AUTHOR_PERSONA constant is the fallback when the file is missing.
  // Two copies that can drift is exactly the bug this whole change fixes, so
  // pin them together rather than trusting discipline.
  it('the fork persona and the inline fallback are identical (modulo platform EOLs)', () => {
    const realFork = path.resolve(__dirname, '../../../../../core-pack/clones/task-author')
    // autocrlf checkouts hand Windows devs a CRLF persona.md while the .ts
    // source keeps its committed LF — that is git checkout noise, not the
    // drift this pin exists to catch. Compare content, not carriage returns.
    const fork = fs.readFileSync(path.join(realFork, 'persona.md'), 'utf-8').replace(/\r\n/g, '\n')
    const def = BUILTIN_CLONES.find((c) => c.name === 'task-author')!
    expect(def.persona.replace(/\r\n/g, '\n')).toBe(fork)
  })
})