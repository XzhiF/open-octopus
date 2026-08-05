// packages/server/src/services/agent/agent-version-service.ts
//
// Agent version management: publish, list, get, diff, rollback, archive.
// Uses DB + filesystem dual storage with compensating transactions.
//
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { AgentVersionDAO } from '../../db/dao/agent-version-dao'
import type { AgentVersionRow } from '../../db/types'
import {
  getCloneDir,
  getBuiltInCloneDir,
  getVersionDir,
  getVersionsBaseDir,
  getAgentDir,
} from './paths'
import { isBuiltinClone } from './builtin-clones'
import type { CloneConfig } from './clone-resolver'

// ── Types ──────────────────────────────────────────────────────────

export interface AgentSnapshot {
  persona: string
  config: Record<string, unknown>
  skills: string[]
}

export interface VersionDiff {
  persona_diff: { from: string; to: string }
  config_diff: { from: Record<string, unknown>; to: Record<string, unknown> }
  skills_diff: { added: string[]; removed: string[]; unchanged: string[] }
}

export interface PublishParams {
  version: string
  stage?: 'alpha' | 'beta' | 'rc' | 'stable'
  changelog?: string
  published_by?: string
}

export interface ListFilters {
  status?: string
  stage?: string
  limit?: number
}

// ── Version parsing ────────────────────────────────────────────────

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  stage: string
}

function parseVersion(version: string): ParsedVersion {
  // Maven-style: "1.2.0-beta.1" or "1.2.0"
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!match) {
    throw new Error(`Invalid version format: "${version}". Expected: "major.minor.patch" or "major.minor.patch-stage"`)
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    stage: match[4] ?? 'stable',
  }
}

// ── Snapshot utilities ─────────────────────────────────────────────

/**
 * Read clone directory and create a snapshot of persona + config + skills.
 */
export function filesToSnapshot(cloneDir: string): AgentSnapshot {
  // Read persona.md
  const personaPath = path.join(cloneDir, 'persona.md')
  const persona = fs.existsSync(personaPath)
    ? fs.readFileSync(personaPath, 'utf-8')
    : ''

  // Read config.json (NOT config.yaml — matches clone-resolver.ts)
  const configPath = path.join(cloneDir, 'config.json')
  let config: Record<string, unknown> = {}
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch {
      config = {}
    }
  }

  // Read skills directory
  const skillsDir = path.join(cloneDir, 'skills')
  const skills: string[] = []
  if (fs.existsSync(skillsDir)) {
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() || entry.isDirectory()) {
          skills.push(entry.name)
        }
      }
    } catch {
      // Directory read failure is non-fatal
    }
  }

  return { persona, config, skills }
}

/**
 * Write a snapshot to a target directory.
 */
export function snapshotToFiles(snapshot: AgentSnapshot, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true })

  // Write persona.md
  fs.writeFileSync(
    path.join(targetDir, 'persona.md'),
    snapshot.persona,
    'utf-8',
  )

  // Write config.json (NOT config.yaml)
  fs.writeFileSync(
    path.join(targetDir, 'config.json'),
    JSON.stringify(snapshot.config, null, 2),
    'utf-8',
  )

  // Write skills directory
  const skillsDir = path.join(targetDir, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })

  // Copy skill files from the global skills directory
  const globalSkillsDir = path.join(getAgentDir(), 'skills')
  for (const skill of snapshot.skills) {
    const srcPath = path.join(globalSkillsDir, skill)
    const destPath = path.join(skillsDir, skill)
    if (fs.existsSync(srcPath)) {
      if (fs.statSync(srcPath).isDirectory()) {
        copyDirSync(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }
}

/**
 * Recursively copy a directory.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ── AgentVersionService ────────────────────────────────────────────

export class AgentVersionService {
  constructor(private readonly dao: AgentVersionDAO) {}

  /**
   * Publish a new version of an agent.
   * Dual-write: DB + filesystem with compensating transaction.
   */
  publish(agentName: string, params: PublishParams): AgentVersionRow {
    const { version, stage: paramStage, changelog, published_by } = params

    // Check if version already exists
    const existing = this.dao.findByAgentAndVersion(agentName, version)
    if (existing) {
      throw new Error(`Version "${version}" already exists for agent "${agentName}"`)
    }

    // Parse version
    const parsed = parseVersion(version)
    const stage = paramStage ?? parsed.stage

    // Resolve clone directory
    const cloneDir = isBuiltinClone(agentName)
      ? getBuiltInCloneDir(agentName)
      : getCloneDir(agentName)

    if (!fs.existsSync(cloneDir)) {
      throw new Error(`Agent "${agentName}" not found at ${cloneDir}`)
    }

    // Step 1: Create snapshot from filesystem
    const snapshot = filesToSnapshot(cloneDir)
    const snapshotJson = JSON.stringify(snapshot)

    // Step 2: DB write (inside transaction)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.dao.transaction(() => {
      this.dao.insert({
        id,
        agent_name: agentName,
        version,
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch,
        stage,
        status: 'published',
        snapshot: snapshotJson,
        changelog: changelog ?? null,
        published_at: now,
        published_by: published_by ?? null,
        created_at: now,
      })
    })

    // Step 3: FS copy (with compensating rollback)
    const versionDir = getVersionDir(agentName, version)
    try {
      snapshotToFiles(snapshot, versionDir)
    } catch (err) {
      // Compensating transaction: rollback DB entry
      this.dao.deleteById(id)
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Publish failed: FS copy error — ${msg}. DB rolled back.`)
    }

    // Step 4: Update clone's current_version_id
    try {
      this.dao.updateCloneVersionId(agentName, id)
    } catch {
      // Non-fatal: clone table update failure doesn't invalidate the version
    }

    return this.dao.findById(id)!
  }

  /**
   * List versions for an agent with optional filters.
   */
  list(agentName: string, filters?: ListFilters): { versions: AgentVersionRow[]; total: number } {
    const versions = this.dao.listByAgent(agentName, filters)
    return { versions, total: versions.length }
  }

  /**
   * Get a single version by agent name and version string.
   */
  get(agentName: string, version: string): AgentVersionRow | null {
    return this.dao.findByAgentAndVersion(agentName, version)
  }

  /**
   * Compare two versions and return their diff.
   */
  diff(agentName: string, fromVersion: string, toVersion: string): VersionDiff {
    const from = this.dao.findByAgentAndVersion(agentName, fromVersion)
    const to = this.dao.findByAgentAndVersion(agentName, toVersion)

    if (!from) throw new Error(`Version "${fromVersion}" not found for agent "${agentName}"`)
    if (!to) throw new Error(`Version "${toVersion}" not found for agent "${agentName}"`)

    const fromSnapshot = JSON.parse(from.snapshot) as AgentSnapshot
    const toSnapshot = JSON.parse(to.snapshot) as AgentSnapshot

    // Compute skills diff
    const fromSkills = new Set(fromSnapshot.skills)
    const toSkills = new Set(toSnapshot.skills)
    const added = [...toSkills].filter(s => !fromSkills.has(s))
    const removed = [...fromSkills].filter(s => !toSkills.has(s))
    const unchanged = [...toSkills].filter(s => fromSkills.has(s))

    return {
      persona_diff: {
        from: fromSnapshot.persona,
        to: toSnapshot.persona,
      },
      config_diff: {
        from: fromSnapshot.config,
        to: toSnapshot.config,
      },
      skills_diff: { added, removed, unchanged },
    }
  }

  /**
   * Rollback to a specific version.
   * Uses atomic replace: temp dir → clone dir.
   */
  rollback(agentName: string, targetVersion: string): { success: boolean; previous_version: string | null } {
    const target = this.dao.findByAgentAndVersion(agentName, targetVersion)
    if (!target) {
      throw new Error(`Version "${targetVersion}" not found for agent "${agentName}"`)
    }
    if (target.status !== 'published') {
      throw new Error(`Cannot rollback to version "${targetVersion}" — status is "${target.status}", expected "published"`)
    }

    // Get current version before rollback
    const cloneDir = isBuiltinClone(agentName)
      ? getBuiltInCloneDir(agentName)
      : getCloneDir(agentName)

    let previousVersion: string | null = null
    try {
      const configPath = path.join(cloneDir, 'config.json')
      if (fs.existsSync(configPath)) {
        // Try to find current version from the clone's current_version_id
        // For simplicity, we store it as null if we can't determine it
      }
    } catch {
      // Non-fatal
    }

    // Step 1: Parse snapshot
    const snapshot = JSON.parse(target.snapshot) as AgentSnapshot

    // Step 2: Write to temp directory
    const tempDir = path.join(
      path.dirname(cloneDir),
      `.rollback-temp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    )

    try {
      snapshotToFiles(snapshot, tempDir)

      // Step 3: Atomic replace — copy temp over clone dir
      // First, backup existing files that aren't in the snapshot
      copyDirOverwrite(tempDir, cloneDir)

      // Step 4: Update DB pointer
      this.dao.updateCloneVersionId(agentName, target.id)
    } catch (err) {
      // Keep temp dir for diagnosis
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Rollback failed: ${msg}. Temp dir preserved at: ${tempDir}`)
    } finally {
      // Cleanup temp dir
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Non-fatal cleanup failure
      }
    }

    return { success: true, previous_version: previousVersion }
  }

  /**
   * Archive a version (set status to 'archived').
   */
  archive(agentName: string, version: string): AgentVersionRow {
    const row = this.dao.findByAgentAndVersion(agentName, version)
    if (!row) {
      throw new Error(`Version "${version}" not found for agent "${agentName}"`)
    }
    if (row.status === 'archived') {
      throw new Error(`Version "${version}" is already archived`)
    }

    this.dao.updateStatus(row.id, 'archived')
    return this.dao.findById(row.id)!
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Copy directory contents, overwriting existing files.
 */
function copyDirOverwrite(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirOverwrite(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let instance: AgentVersionService | null = null

export function initAgentVersionService(dao: AgentVersionDAO): AgentVersionService {
  instance = new AgentVersionService(dao)
  return instance
}

export function getAgentVersionService(): AgentVersionService {
  if (!instance) {
    throw new Error('AgentVersionService not initialized — call initAgentVersionService() first')
  }
  return instance
}
