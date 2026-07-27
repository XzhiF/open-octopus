// packages/server/src/services/agent/clone-resolver.ts
//
// Filesystem-based clone definition resolver.
// Reads clone definitions from built-in/ and clones/ directories.
// Source of truth for clone definitions (not DB).
//
import fs from 'fs'
import path from 'path'
import { getBuiltInClonesDir, getClonesDir, getBuiltInCloneDir, getCloneDir } from './paths'
import { BUILTIN_CLONES, isBuiltinClone } from './builtin-clones'

// ── Types ──────────────────────────────────────────────────────────

/**
 * CloneInfo — API response type for clone listing.
 */
export interface CloneInfo {
  name: string
  display_name: string
  type: 'built-in' | 'user'
  persona: string           // Persona excerpt (first 200 chars)
  skills: string[]
  memory_scope: 'shared' | 'isolated'
  status: 'active' | 'idle' | 'executing'
  created_at?: string
  last_active?: string
}

/**
 * CloneConfig — config.json on-disk format.
 */
export interface CloneConfig {
  name: string
  display_name?: string
  type?: 'built-in' | 'user'
  skills?: string[]
  memoryScope?: 'shared' | 'isolated'
  config?: Record<string, unknown>
  created_at?: string
  last_active?: string
}

// ── Safe name validation ───────────────────────────────────────────

const SAFE_NAME_RE = /^[a-z0-9-]+$/

export function isValidCloneName(name: string): boolean {
  return SAFE_NAME_RE.test(name) && name.length > 0 && name.length <= 50
}

// ── Resolver functions ─────────────────────────────────────────────

/**
 * Resolve a single clone's info from the filesystem.
 * Checks built-in directory first, then user clones directory.
 * Returns null if not found.
 */
export function resolveCloneInfo(name: string): CloneInfo | null {
  // Check built-in
  if (isBuiltinClone(name)) {
    return resolveBuiltinCloneInfo(name)
  }

  // Check user clones
  return resolveUserCloneInfo(name)
}

/**
 * List all clones (built-in + user) from the filesystem.
 */
export function listAllClones(): CloneInfo[] {
  const clones: CloneInfo[] = []

  // 1. Built-in clones
  for (const def of BUILTIN_CLONES) {
    const info = resolveBuiltinCloneInfo(def.name)
    if (info) clones.push(info)
  }

  // 2. User clones from filesystem
  const clonesDir = getClonesDir()
  if (fs.existsSync(clonesDir)) {
    try {
      const entries = fs.readdirSync(clonesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !clones.some(c => c.name === entry.name)) {
          const info = resolveUserCloneInfo(entry.name)
          if (info) clones.push(info)
        }
      }
    } catch {
      // Directory read failure is non-fatal
    }
  }

  return clones
}

/**
 * Create a user clone on the filesystem.
 * Creates directory + config.json + persona.md.
 */
export function createUserClone(params: {
  name: string
  display_name: string
  persona: string
  skills?: string[]
  workspace?: { name?: string; path?: string }
  memory_scope?: 'shared' | 'isolated'
}): { ok: true; clone: CloneInfo } | { ok: false; error: string } {
  const { name, display_name, persona, skills = [], workspace, memory_scope = 'isolated' } = params

  // Validate name
  if (!isValidCloneName(name)) {
    return { ok: false, error: 'name must be lowercase alphanumeric with hyphens, 1-50 chars' }
  }

  // Check built-in conflict
  if (isBuiltinClone(name)) {
    return { ok: false, error: `Cannot create user clone with built-in name "${name}"` }
  }

  // Check existence
  const cloneDir = getCloneDir(name)
  if (fs.existsSync(cloneDir)) {
    return { ok: false, error: `Clone "${name}" already exists` }
  }

  // Create directory structure
  try {
    fs.mkdirSync(cloneDir, { recursive: true })
    fs.mkdirSync(path.join(cloneDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(cloneDir, 'memory'), { recursive: true })

    // Write config.json
    const config: CloneConfig = {
      name,
      display_name,
      type: 'user',
      skills,
      memoryScope: memory_scope,
      config: {},
      created_at: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(cloneDir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8')

    // Write persona.md
    fs.writeFileSync(path.join(cloneDir, 'persona.md'), persona, 'utf-8')

    return { ok: true, clone: resolveUserCloneInfo(name)! }
  } catch (err) {
    // Cleanup on failure
    try { fs.rmSync(cloneDir, { recursive: true, force: true }) } catch { /* non-fatal */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Delete a user clone from the filesystem.
 * Returns error for built-in clones.
 */
export function deleteUserClone(name: string): { ok: true } | { ok: false; error: string; status?: number } {
  if (isBuiltinClone(name)) {
    return { ok: false, error: `Built-in clone "${name}" cannot be deleted`, status: 403 }
  }

  const cloneDir = getCloneDir(name)
  if (!fs.existsSync(cloneDir)) {
    return { ok: false, error: `Clone "${name}" not found`, status: 404 }
  }

  try {
    fs.rmSync(cloneDir, { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Private helpers ────────────────────────────────────────────────

function resolveBuiltinCloneInfo(name: string): CloneInfo | null {
  const def = BUILTIN_CLONES.find(c => c.name === name)
  if (!def) return null

  const cloneDir = getBuiltInCloneDir(name)
  const config = readCloneConfig(cloneDir)
  const persona = readPersona(cloneDir, def.persona)

  return {
    name: def.name,
    display_name: config?.display_name ?? def.displayName ?? def.name,
    type: 'built-in',
    persona: persona.slice(0, 200),
    skills: config?.skills ?? def.skills,
    memory_scope: (config?.memoryScope ?? def.memoryScope) as 'shared' | 'isolated',
    status: 'active',
    created_at: config?.created_at,
    last_active: config?.last_active,
  }
}

function resolveUserCloneInfo(name: string): CloneInfo | null {
  const cloneDir = getCloneDir(name)
  if (!fs.existsSync(cloneDir)) return null

  const config = readCloneConfig(cloneDir)
  if (!config) {
    // Directory exists but no config — skip
    return null
  }

  const persona = readPersona(cloneDir, '')

  return {
    name: config.name ?? name,
    display_name: config.display_name ?? config.name ?? name,
    type: 'user',
    persona: persona.slice(0, 200),
    skills: config.skills ?? [],
    memory_scope: (config.memoryScope ?? 'isolated') as 'shared' | 'isolated',
    workspace: config.workspace ? {
      name: config.workspace.name ?? '',
      path: config.workspace.path ?? '',
    } : undefined,
    status: 'idle',
    created_at: config.created_at,
    last_active: config.last_active,
  }
}

function readCloneConfig(cloneDir: string): CloneConfig | null {
  const configPath = path.join(cloneDir, 'config.json')
  if (!fs.existsSync(configPath)) return null
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as CloneConfig
  } catch {
    return null
  }
}

function readPersona(cloneDir: string, fallback: string): string {
  const personaPath = path.join(cloneDir, 'persona.md')
  if (fs.existsSync(personaPath)) {
    try {
      return fs.readFileSync(personaPath, 'utf-8')
    } catch {
      // Fall through
    }
  }
  return fallback
}
