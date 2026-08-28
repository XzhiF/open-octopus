// packages/server/src/services/agent/clone-init-service.ts
//
// Auto-initialization for built-in clones on server startup.
// Creates filesystem structure and registers in DB (idempotent).
//
import fs from 'fs'
import path from 'path'
import type { CloneDef } from '@octopus/shared'
import type { CloneDAO } from '../../db/dao'
import { BUILTIN_CLONES } from './builtin-clones'
import { getBuiltInClonesDir, getBuiltInCloneDir, getBuiltInCloneMemoryDir } from './paths'
import { DEFAULT_WORKFLOW_PRESETS_YAML, PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS, PRESETS_VERSION, hashPresetsContent } from './workflow-presets-seed'

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

    // 2. Write default persona.md (skip if exists)
    const personaPath = path.join(cloneDir, 'persona.md')
    if (!fs.existsSync(personaPath)) {
      fs.writeFileSync(personaPath, cloneDef.persona, 'utf-8')
      result.filesCreated.push(`built-in/${name}/persona.md`)
    } else {
      result.filesSkipped.push(`built-in/${name}/persona.md`)
    }

    // 3. Write config.json
    const configPath = path.join(cloneDir, 'config.json')
    if (!fs.existsSync(configPath)) {
      const config = {
        name: cloneDef.name,
        display_name: cloneDef.displayName ?? cloneDef.name,
        type: cloneDef.type,
        skills: cloneDef.skills,
        memoryScope: cloneDef.memoryScope,
        config: cloneDef.config,
        created_at: new Date().toISOString(),
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
      result.filesCreated.push(`built-in/${name}/config.json`)
    } else {
      result.filesSkipped.push(`built-in/${name}/config.json`)
    }

    // 3. Seed/migrate workflow-presets.yaml for the task-author clone
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

    // 4. Register in DB (skip if exists)
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
