// packages/server/src/services/agent/clone-init-service.ts
//
// Auto-initialization for built-in clones on server startup.
// Creates filesystem structure and registers in DB (idempotent).
//
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { copyDirSync, type CloneDef } from '@octopus/shared'
import type { CloneDAO } from '../../db/dao'
import { BUILTIN_CLONES, PREV_BUILTIN_PERSONA_HASHES, builtinPersonaHash, normalizePersonaText } from './builtin-clones'
import { getBuiltInClonesDir, getBuiltInCloneDir, getBuiltInCloneMemoryDir } from './paths'
import { DEFAULT_WORKFLOW_PRESETS_YAML, PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS, PRESETS_VERSION, hashPresetsContent } from './workflow-presets-seed'

// ── task-author clone assets (fork source) ──────────────────────────────
//
// The task-author clone's persona + skill family are NOT copied from the repo's
// shared `.claude/skills/` tree — that is the *development* session's skill
// tree, whose copies carry execution-side exits ("Next Steps: run
// matt-dev-pipeline / matt-pipeline-loop") that are wrong for a spec author.
// They live in `packages/core-pack/clones/task-author/` as a deliberate fork;
// see that directory's README for what diverges and why.
//
// Seeding is versioned, following the workflow-presets precedent
// (workflow-presets-seed.ts) adapted from one file to a directory tree: a
// `.seed-manifest.json` records the sha256 of every file we last wrote, so an
// untouched file can be refreshed from the fork while a hand-edited one is
// preserved.
export const TASK_AUTHOR_SEED_MANIFEST = '.seed-manifest.json'

/** The skill family the fork ships. Declared (not derived by scanning) so a
 *  test can assert the fork's `skills/` dir matches it exactly — adding or
 *  renaming a skill must be a conscious act, not a silent drift. */
export const MATT_SKILL_FAMILY: readonly string[] = [
  'author-verified-requirement',
  'author-verified-spec',
  'author-verified-tickets',
  'domain-modeling',
  'grilling',
  'wayfinder',
]

/** Locate the task-author clone asset source
 *  (`packages/core-pack/clones/task-author/`). Exported so tests can point at a
 *  temp tree rather than the real repo. Returns null when unavailable (a
 *  packaged install without the repo tree) — seeding is then a silent no-op,
 *  the same posture as copyBuiltinSkills. */
export function findTaskAuthorSeedDir(): string | null {
  // Explicit override — used by tests to drive a temp source tree through the
  // refresh matrix, and available to a packaged install that ships the fork
  // somewhere other than the repo layout below.
  const override = process.env.OCTOPUS_TASK_AUTHOR_SEED_DIR
  if (override && fs.existsSync(path.join(override, 'persona.md'))) return override

  const candidates = [
    // src/services/agent and dist/services/agent both sit 4 levels under packages/
    path.resolve(__dirname, '../../../../core-pack/clones/task-author'),
    path.resolve(process.cwd(), 'packages/core-pack/clones/task-author'), // cwd = repo root
    path.resolve(process.cwd(), '../core-pack/clones/task-author'),       // cwd = packages/server
    path.resolve(process.cwd(), '../../core-pack/clones/task-author'),    // cwd = packages/* subdirs
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'persona.md'))) return c
  }
  return null
}

// ── archive clone assets (fork source — 票06 llm-wiki-loop) ──────────────
//
// octo-wiki-curate 是写侧技能：ADR-0006 实态下 getPlugins() 忽略 CloneDef.skills，
// 共享层被全部分身继承——写侧技能进共享层 = 把 wiki 写权泄漏给全员。故它只能落
// archive 分身层（clones/archive/skills/），与 task-author fork 同一装机路径。
// 声明（而非扫目录得出）便于测试钉死 fork 树：目录漂移必须是自觉行为。
export const ARCHIVE_CURATE_SKILL_FAMILY: readonly string[] = ['octo-wiki-curate']

/** Locate the archive clone asset source (`packages/core-pack/clones/archive/`).
 *  同 findTaskAuthorSeedDir：env 覆盖供测试驱动；不可用时 null（装机静默跳过）。 */
export function findArchiveSeedDir(): string | null {
  const override = process.env.OCTOPUS_ARCHIVE_SEED_DIR
  if (override && fs.existsSync(path.join(override, 'persona.md'))) return override

  const candidates = [
    path.resolve(__dirname, '../../../../core-pack/clones/archive'),
    path.resolve(process.cwd(), 'packages/core-pack/clones/archive'),
    path.resolve(process.cwd(), '../core-pack/clones/archive'),
    path.resolve(process.cwd(), '../../core-pack/clones/archive'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'persona.md'))) return c
  }
  return null
}

/** Relative paths of every file under `root`, restricted to the given entries.
 *  Each entry is a file (`persona.md`) or a directory (`skills`) walked
 *  recursively. Returns posix-normalized relative paths. */
export function collectSeedFiles(root: string, entries: readonly string[]): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    const abs = path.join(root, rel)
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return
    }
    if (st.isFile()) {
      out.push(rel.split(path.sep).join('/'))
      return
    }
    if (!st.isDirectory()) return
    for (const name of fs.readdirSync(abs)) walk(path.join(rel, name))
  }
  for (const entry of entries) walk(entry)
  return out
}

/** sha256 hex of a file, or null when it does not exist / cannot be read. */
function sha256File(abs: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

interface SeedManifest {
  version: number
  files: Record<string, string>
}

// ── Types ──────────────────────────────────────────────────────────

export interface CloneInitResult {
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
  /** Seed-migration refreshes (goal-task-dev 05): existed as an untouched
   *  previous default → rewritten to the current default. */
  filesRefreshed: string[]
  dbRegistered: string[]
  dbSkipped: string[]
}

// ── CloneInitService ──────────────────────────────────────────────

export class CloneInitService {
  /** Paths already warned about this process (warn-once per user-modified file). */
  private readonly warnedUserModified = new Set<string>()

  /**
   * Initialize built-in clones if not exists (idempotent).
   * Creates directory structure, writes default persona.md,
   * and registers in clones table with type='built-in'.
   */
  initBuiltInClones(org: string, cloneDAO: CloneDAO): CloneInitResult {
    const result: CloneInitResult = {
      dirsCreated: [],
      filesCreated: [],
      filesSkipped: [],
      filesRefreshed: [],
      dbRegistered: [],
      dbSkipped: [],
    }

    for (const cloneDef of BUILTIN_CLONES) {
      this.initSingleClone(cloneDef, org, cloneDAO, result)
    }

    return result
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /** Seed the task-author clone's own assets — `persona.md` + the whole
   *  `skills/` tree — from the fork at `packages/core-pack/clones/task-author/`.
   *
   *  Versioned refresh via `{cloneDir}/.seed-manifest.json` (sha256 per file):
   *    no manifest      → back up what is there, then take over wholesale.
   *                       Can't tell a stale seed from a hand-edit, so the
   *                       backup is the only safety net. This is the one-time
   *                       migration for installs seeded before versioning.
   *    sha == recorded  → untouched → overwrite from the fork (upgrade lands)
   *    sha != recorded  → hand-edited → keep, warn once
   *    dest missing     → write it (deleting a file is the documented way to
   *                       force a re-seed, so re-writing is the intent)
   *    source gone      → remove the orphan this seed wrote (untouched sha), so a
   *                       renamed skill does not stay discoverable under its old
   *                       name; hand-edited → keep, warn once; never-written →
   *                       forget
   *
   *  Non-fatal throughout: a failure leaves the clone with one asset less, and
   *  the session still runs (same posture as copyBuiltinSkills). */
  private seedTaskAuthorAssets(cloneDir: string, result: CloneInitResult): void {
    this.seedForkAssets('task-author', findTaskAuthorSeedDir(), cloneDir, result)
  }

  /** Seed the archive (curator) clone's assets — persona.md + octo-wiki-curate —
   *  from the fork at packages/core-pack/clones/archive/ (票06). Same versioned
   *  manifest discipline as task-author; clone-tier placement is the whole point
   *  (ADR-0006: shared tier would leak the wiki write gate to every clone). */
  private seedArchiveAssets(cloneDir: string, result: CloneInitResult): void {
    this.seedForkAssets('archive', findArchiveSeedDir(), cloneDir, result)
  }

  private seedForkAssets(cloneName: string, srcRoot: string | null, cloneDir: string, result: CloneInitResult): void {
    if (!srcRoot) return

    const manifestPath = path.join(cloneDir, TASK_AUTHOR_SEED_MANIFEST)
    const prev = this.readSeedManifest(manifestPath)
    if (!prev) this.backupSeedTargets(cloneName, cloneDir, result)

    const srcFiles = collectSeedFiles(srcRoot, ['persona.md', 'skills'])
    const nextFiles: Record<string, string> = {}

    for (const rel of srcFiles) {
      const key = `built-in/${cloneName}/${rel}`
      const srcAbs = path.join(srcRoot, rel)
      const destAbs = path.join(cloneDir, rel)
      const srcHash = sha256File(srcAbs)
      if (srcHash === null) continue // unreadable source — nothing to seed
      nextFiles[rel] = srcHash

      const destHash = sha256File(destAbs)
      if (destHash === null) {
        this.seedCopyFile(srcAbs, destAbs, key, result, false)
        continue
      }
      if (destHash === srcHash) {
        result.filesSkipped.push(key) // already fresh
        continue
      }
      // Content differs. With a manifest, only an untouched file is safe to
      // overwrite — a differing hash means the user edited it.
      const recorded = prev?.files[rel]
      if (prev && recorded !== undefined && destHash !== recorded) {
        result.filesSkipped.push(key)
        this.warnUserModified(destAbs, key)
        continue
      }
      this.seedCopyFile(srcAbs, destAbs, key, result, true)
    }

    // Orphan sweep — a file we once seeded whose source is gone from the fork
    // (the usual cause: a skill rename). Deleting the old dest is not enough:
    // the SDK discovers skills by frontmatter `name` across the whole skills/
    // tree, so an untouched old copy would keep answering to the retired name
    // next to its renamed twin. Removal is safe only when the dest still equals
    // what we last wrote; a hand-edited orphan is the user's file — keep, warn.
    // (No-manifest installs skip this: without a recorded sha we cannot tell a
    // stale seed from a hand-edit, so the backup above is the only safety net.)
    if (prev) {
      const srcSet = new Set(srcFiles)
      for (const rel of Object.keys(prev.files)) {
        if (srcSet.has(rel)) continue
        const key = `built-in/${cloneName}/${rel}`
        const destAbs = path.join(cloneDir, rel)
        const destHash = sha256File(destAbs)
        if (destHash === null) continue // already gone from disk — just forget it
        if (destHash !== prev.files[rel]) {
          result.filesSkipped.push(key)
          this.warnUserModified(destAbs, key)
          continue
        }
        this.seedRemoveFile(destAbs, key, cloneDir, result)
      }
    }

    try {
      const manifest: SeedManifest = { version: 1, files: nextFiles }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
    } catch (err: unknown) {
      // Losing the manifest only costs us the next run's edit detection.
      console.warn(
        `[CloneInitService] could not write ${TASK_AUTHOR_SEED_MANIFEST}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Write ⧸ refresh ⧸ preserve a built-in persona template (step 3 rules).
   *  Untouched detection: the config.json `persona_template_hash` stamp when
   *  present, else the embedded previous-template hash ledger (one-time
   *  migration for installs seeded before tracking existed). */
  private seedBuiltinPersona(
    cloneName: string,
    cloneDef: CloneDef,
    cloneDir: string,
    personaPath: string,
    result: CloneInitResult,
  ): void {
    const key = `built-in/${cloneName}/persona.md`
    const current = cloneDef.persona
    const currentHash = builtinPersonaHash(cloneDef)

    let existing: string | null = null
    if (fs.existsSync(personaPath)) {
      try {
        existing = fs.readFileSync(personaPath, 'utf-8')
      } catch {
        existing = null
      }
    }

    if (existing === null) {
      try {
        fs.writeFileSync(personaPath, current, 'utf-8')
        result.filesCreated.push(key)
      } catch (err: unknown) {
        console.warn(`[CloneInitService] seed failed for ${key}:`, err instanceof Error ? err.message : String(err))
      }
      return
    }

    const diskHash = createHash('sha256').update(normalizePersonaText(existing), 'utf-8').digest('hex')
    if (diskHash === currentHash) {
      result.filesSkipped.push(key)
      this.updateBuiltinPersonaStamp(cloneDir, currentHash)
      return
    }

    const recorded = this.readBuiltinPersonaStamp(cloneDir)
    const untouched = recorded !== null
      ? diskHash === recorded
      : (PREV_BUILTIN_PERSONA_HASHES[cloneName] ?? []).includes(diskHash)

    if (untouched) {
      try {
        fs.writeFileSync(personaPath, current, 'utf-8')
        result.filesRefreshed.push(key)
        this.updateBuiltinPersonaStamp(cloneDir, currentHash)
        console.log(`[CloneInitService] ${key} matched a previous template — refreshed to the current one`)
      } catch (err: unknown) {
        console.warn(`[CloneInitService] refresh failed for ${key}:`, err instanceof Error ? err.message : String(err))
      }
      return
    }

    result.filesSkipped.push(key)
    this.warnUserModified(personaPath, key)
  }

  /** config.json `persona_template_hash`, or null when absent/unreadable. */
  private readBuiltinPersonaStamp(cloneDir: string): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(cloneDir, 'config.json'), 'utf-8')) as {
        persona_template_hash?: unknown
      }
      return typeof raw.persona_template_hash === 'string' ? raw.persona_template_hash : null
    } catch {
      return null
    }
  }

  /** Stamp the last-written template hash into config.json (merge-write).
   *  No-op when config.json does not exist yet — step 4 creates it stamped. */
  private updateBuiltinPersonaStamp(cloneDir: string, hash: string): void {
    const configPath = path.join(cloneDir, 'config.json')
    try {
      if (!fs.existsSync(configPath)) return
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
      if (raw.persona_template_hash === hash) return
      raw.persona_template_hash = hash
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf-8')
    } catch (err: unknown) {
      // Losing the stamp only costs the next run's edit detection.
      console.warn(
        `[CloneInitService] could not stamp persona_template_hash in ${cloneDir}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Read the seed manifest, or null when missing/unparseable. */
  private readSeedManifest(manifestPath: string): SeedManifest | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SeedManifest
      if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object') return null
      return parsed
    } catch {
      return null
    }
  }

  /** One-time migration safety net: move the existing `persona.md` + `skills/`
   *  aside before we overwrite them, so hand-edits made before versioning
   *  existed are recoverable. No-op when there is nothing to back up. */
  private backupSeedTargets(cloneName: string, cloneDir: string, result: CloneInitResult): void {
    const targets = ['persona.md', 'skills'].filter((t) => fs.existsSync(path.join(cloneDir, t)))
    if (targets.length === 0) return

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(cloneDir, `seed.bak-${stamp}`)
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      for (const t of targets) {
        const src = path.join(cloneDir, t)
        const dst = path.join(backupDir, t)
        if (fs.statSync(src).isDirectory()) copyDirSync(src, dst)
        else fs.copyFileSync(src, dst)
      }
      result.dirsCreated.push(`built-in/${cloneName}/seed.bak-${stamp}`)
      console.warn(
        `[CloneInitService] ${cloneName} assets were not versioned yet — backed up to ` +
        `built-in/${cloneName}/seed.bak-${stamp}/ before the first managed seed. ` +
        `Local edits are now tracked by ${TASK_AUTHOR_SEED_MANIFEST} and will be preserved.`,
      )
    } catch (err: unknown) {
      // Losing the backup is bad but not fatal — warn loudly and carry on.
      console.warn(
        `[CloneInitService] could not back up task-author assets:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Copy one seed file into place, creating parent dirs. `refreshed` picks the
   *  result bucket (filesRefreshed vs filesCreated). */
  private seedCopyFile(
    srcAbs: string,
    destAbs: string,
    key: string,
    result: CloneInitResult,
    refreshed: boolean,
  ): void {
    try {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true })
      fs.copyFileSync(srcAbs, destAbs)
      if (refreshed) result.filesRefreshed.push(key)
      else result.filesCreated.push(key)
    } catch (err: unknown) {
      console.warn(
        `[CloneInitService] seed failed for ${key}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Delete one orphan seed file (source gone from the fork, dest untouched),
   *  then prune empty parent dirs up to the clone root — otherwise a renamed
   *  skill leaves an empty directory shell behind. */
  private seedRemoveFile(
    destAbs: string,
    key: string,
    cloneDir: string,
    result: CloneInitResult,
  ): void {
    try {
      fs.rmSync(destAbs)
      result.filesRefreshed.push(key)
      let dir = path.dirname(destAbs)
      while (dir.startsWith(cloneDir + path.sep) && dir !== cloneDir) {
        if ((fs.readdirSync(dir) as string[]).length > 0) break
        fs.rmdirSync(dir)
        dir = path.dirname(dir)
      }
    } catch (err: unknown) {
      console.warn(
        `[CloneInitService] orphan cleanup failed for ${key}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Warn once per process per file (see `warnedUserModified`). */
  private warnUserModified(destAbs: string, key: string): void {
    if (this.warnedUserModified.has(destAbs)) return
    this.warnedUserModified.add(destAbs)
    console.warn(
      `[CloneInitService] ${key} was user-modified — keeping it; ` +
      `seed updates NOT applied (delete the file to re-seed)`,
    )
  }

  private initSingleClone(
    cloneDef: CloneDef,
    org: string,
    cloneDAO: CloneDAO,
    result: CloneInitResult,
  ): void {
    const name = cloneDef.name
    const cloneDir = getBuiltInCloneDir(name)
    const memoryDir = getBuiltInCloneMemoryDir(name)
    const dailyDir = path.join(memoryDir, 'daily')

    // 1. Create directory structure
    if (!fs.existsSync(cloneDir)) {
      fs.mkdirSync(cloneDir, { recursive: true })
      result.dirsCreated.push(`built-in/${name}`)
    }
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true })
      result.dirsCreated.push(`built-in/${name}/memory`)
    }
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true })
      result.dirsCreated.push(`built-in/${name}/memory/daily`)
    }

    // 2. Seed the task-author clone's own assets — persona.md + the whole
    // skills/ tree — from the fork at packages/core-pack/clones/task-author/
    // (see seedTaskAuthorAssets). Versioned refresh: an untouched file is
    // upgraded from the fork, a hand-edited one is preserved. This is what
    // replaced the old copy-from-.claude/skills-once, which never refreshed and
    // so silently stranded installs on stale skills.
    //
    // Runs BEFORE the persona fallback below so that:
    //   - a fresh install never writes a fallback persona just for the seed to
    //     treat it as pre-existing (and back it up) on the same run;
    //   - `persona.md` is owned by the fork when the fork is present.
    if (name === 'task-author') {
      this.seedTaskAuthorAssets(cloneDir, result)
    }
    if (name === 'archive') {
      this.seedArchiveAssets(cloneDir, result)
    }

    // 3. Write/migrate persona.md. task-author / archive personas are owned by
    // their forks (step 2) and left alone; every other built-in template is
    // versioned like the workflow presets:
    //   missing                  → write the current template
    //   ≡ current template       → skip (already fresh)
    //   ≡ a previous template    → refresh to the current one + log. An old
    //                              seed copy must never shadow a code update.
    //   hand-edited              → preserve + warn once (delete to re-seed)
    const personaPath = path.join(cloneDir, 'persona.md')
    const forkOwnedPersona = name === 'task-author' || name === 'archive'
    if (forkOwnedPersona) {
      result.filesSkipped.push(`built-in/${name}/persona.md`)
    } else {
      this.seedBuiltinPersona(name, cloneDef, cloneDir, personaPath, result)
    }

    // 4. Write config.json (creation stamps the persona template hash so the
    //    next run can tell an untouched seed from a hand-edit).
    const configPath = path.join(cloneDir, 'config.json')
    if (!fs.existsSync(configPath)) {
      const config = {
        name: cloneDef.name,
        display_name: cloneDef.displayName ?? cloneDef.name,
        type: cloneDef.type,
        skills: cloneDef.skills,
        memoryScope: cloneDef.memoryScope,
        config: cloneDef.config,
        persona_template_hash: builtinPersonaHash(cloneDef),
        created_at: new Date().toISOString(),
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
      result.filesCreated.push(`built-in/${name}/config.json`)
    } else {
      result.filesSkipped.push(`built-in/${name}/config.json`)
    }

    // 5. Seed/migrate workflow-presets.yaml for the task-author clone
    // (task-workflow-presets T3 review fix; versioned migration added by
    // goal-task-dev ticket 05): pure skip-if-exists meant existing installs
    // NEVER refreshed the default catalog (general-dev kept pointing at
    // matt-dev-pipeline after the task-dev rebinding). Now:
    //   missing            → write current default
    //   ≡ any historical default → refresh to current default + log
    //   ≡ current default  → skip (already fresh, no warn)
    //   anything else      → user hand-edit: preserve + warn once
    // The content comparison is normalized (version header + trailing
    // whitespace stripped, see hashPresetsContent) so the migration marker
    // itself never causes a false "user-modified" verdict.
    if (name === 'task-author') {
      const presetsPath = path.join(cloneDir, 'workflow-presets.yaml')
      const presetsKey = `built-in/${name}/workflow-presets.yaml`
      if (!fs.existsSync(presetsPath)) {
        fs.writeFileSync(presetsPath, DEFAULT_WORKFLOW_PRESETS_YAML, 'utf-8')
        result.filesCreated.push(presetsKey)
      } else {
        let existing: string | null = null
        try {
          existing = fs.readFileSync(presetsPath, 'utf-8')
        } catch {
          result.filesSkipped.push(presetsKey)
          // unreadable — leave it alone entirely (DB registration continues below)
        }
        if (existing !== null) {
          const hash = hashPresetsContent(existing)
          if (PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS.some((prev) => hash === hashPresetsContent(prev))) {
            fs.writeFileSync(presetsPath, DEFAULT_WORKFLOW_PRESETS_YAML, 'utf-8')
            result.filesRefreshed.push(presetsKey)
            console.log(
              `[CloneInitService] ${presetsKey} matched the embedded previous default — ` +
              `refreshed to seed default v${PRESETS_VERSION}`,
            )
          } else if (hash === hashPresetsContent(DEFAULT_WORKFLOW_PRESETS_YAML)) {
            result.filesSkipped.push(presetsKey)
          } else {
            result.filesSkipped.push(presetsKey)
            if (!this.warnedUserModified.has(presetsPath)) {
              this.warnedUserModified.add(presetsPath)
              console.warn(
                `[CloneInitService] ${presetsKey} was user-modified — keeping it; ` +
                `seed default v${PRESETS_VERSION} NOT applied (delete the file to re-seed)`,
              )
            }
          }
        }
      }
    }

    // 6. Register in DB (skip if exists)
    try {
      const existing = cloneDAO.findByName(name)
      if (!existing) {
        const now = new Date().toISOString()
        cloneDAO.insert({
          name: cloneDef.name,
          org,
          type: 'built-in',
          status: 'active',
          persona: cloneDef.persona,
          skills: JSON.stringify(cloneDef.skills),
          workspace_ref: cloneDef.workspaceRef ? JSON.stringify(cloneDef.workspaceRef) : '{}',
          memory_scope: cloneDef.memoryScope,
          last_active_at: null,
          created_at: now,
          updated_at: now,
        })
        result.dbRegistered.push(name)
      } else {
        result.dbSkipped.push(name)
      }
    } catch (err) {
      // DB registration failure is non-fatal — clone still works via filesystem
      console.warn(`[CloneInitService] DB registration failed for ${name}:`,
        err instanceof Error ? err.message : String(err))
      result.dbSkipped.push(name)
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let cloneInitServiceInstance: CloneInitService | null = null

export function getCloneInitService(): CloneInitService {
  if (!cloneInitServiceInstance) {
    cloneInitServiceInstance = new CloneInitService()
  }
  return cloneInitServiceInstance
}
