// packages/server/src/services/agent/clone-runtime.ts
//
// CloneRuntime — shared infrastructure layer for all clones.
// Responsibilities:
//   1. Context Assembly: build clone-specific system prompt (persona + skills + memory)
//   2. Provider Call Encapsulation: unified Claude SDK invocation with resume + append
//   3. Error Recovery: graceful degradation (fallback, retry without resume, log-only)
//
import fs from 'fs'
import path from 'path'
import type { MessageChunk } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import type { CloneDef } from '@octopus/shared'
import {
  getAgentDir,
  getAgentSkillsDir,
  getLongTermMemoryPath,
  getDailyMemoryDir,
  getBuiltInCloneDir,
  getBuiltInCloneMemoryDir,
  getCloneDir,
  getCloneSkillsDir,
} from './paths'

// ── Types ──────────────────────────────────────────────────────────

/** Internal skill entry from directory scanning. */
interface SkillEntry {
  name: string
  description: string
}

export interface CloneChatResult {
  content: string
  thinking: string
  providerSessionId: string | null
  toolCalls: Array<{
    id: string
    name: string
    input?: unknown
    result?: unknown
    isError?: boolean
  }>
}

// ── CloneRuntime ───────────────────────────────────────────────────

/**
 * Shared infrastructure layer for all clones.
 * Encapsulates context assembly, provider calls, and error recovery.
 */
export class CloneRuntime {
  private org: string
  private cloneDef: CloneDef

  constructor(cloneDef: CloneDef, org: string) {
    this.cloneDef = cloneDef
    this.org = org
  }

  // ── Context Assembly ────────────────────────────────────────────

  /**
   * Assemble clone-specific system prompt from persona + skills + memory.
   */
  assembleContext(): string {
    const segments: string[] = []

    // 1. Persona (replaces main agent persona)
    const persona = this.loadPersona()
    if (persona) {
      segments.push(persona)
    }

    // 2. Shared memory (global long-term + daily, read-only)
    const sharedMemory = this.readSharedMemory()
    if (sharedMemory) {
      segments.push(sharedMemory)
    }

    // 3. Isolated memory (clone-specific)
    const isolatedMemory = this.readIsolatedMemory()
    if (isolatedMemory) {
      segments.push(isolatedMemory)
    }

    // Skills are no longer included as prompt text.
    // The Claude Agent SDK discovers skills natively via the `plugins` option
    // (see getPlugins() + sendWithProvider()). See ADR-006.

    return segments.filter(Boolean).join('\n\n')
  }

  /**
   * Read shared memory (global long-term + daily, read-only).
   */
  readSharedMemory(): string {
    if (this.cloneDef.memoryScope === 'isolated') {
      return ''
    }

    const parts: string[] = []

    // Long-term memory
    const ltPath = getLongTermMemoryPath()
    if (fs.existsSync(ltPath)) {
      try {
        const content = fs.readFileSync(ltPath, 'utf-8').trim()
        if (content) parts.push(`# 共享长期记忆\n\n${content}`)
      } catch {
        // Read failure is non-fatal
      }
    }

    // Daily memory (today)
    const dailyDir = getDailyMemoryDir()
    if (fs.existsSync(dailyDir)) {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const todayFile = path.join(dailyDir, `${today}.md`)
        if (fs.existsSync(todayFile)) {
          const content = fs.readFileSync(todayFile, 'utf-8').trim()
          if (content) parts.push(`# 共享工作记忆\n\n${content}`)
        }
      } catch {
        // Read failure is non-fatal
      }
    }

    return parts.join('\n\n')
  }

  /**
   * Write to isolated memory (clone-specific).
   */
  writeIsolatedMemory(content: string): void {
    try {
      const memoryDir = getBuiltInCloneMemoryDir(this.cloneDef.name)
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true })
      }

      const today = new Date().toISOString().slice(0, 10)
      const filePath = path.join(memoryDir, 'daily', `${today}.md`)
      const dailyDir = path.dirname(filePath)
      if (!fs.existsSync(dailyDir)) {
        fs.mkdirSync(dailyDir, { recursive: true })
      }

      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
      const time = new Date().toTimeString().split(' ')[0]
      fs.writeFileSync(filePath, `${existing}\n### ${time}\n${content}\n`, 'utf-8')
    } catch (err) {
      // Memory write failure is non-fatal — log only
      console.warn(`[CloneRuntime] Memory write failed for ${this.cloneDef.name}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // ── CWD Strategy ───────────────────────────────────────────────

  /**
   * Get the default CWD for this clone — its own directory.
   * built-in: ~/.octopus/agent/built-in/{name}/
   * user:     ~/.octopus/agent/clones/{name}/
   * Callers (e.g. workspace chat) can override by passing their own cwd.
   */
  getDefaultCwd(): string {
    return this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)
  }

  // ── Plugin Discovery (ADR-006) ──────────────────────────────────

  /**
   * Build the plugins array for Claude Agent SDK skill discovery.
   *
   * Main plugin: ~/.octopus/agent/ — shared skills in skills/
   * Clone plugin: built-in/{name}/ or clones/{name}/ — clone-specific skills
   *
   * The SDK scans each plugin's direct skills/ subdirectory (non-recursive)
   * and injects discovered skills into the system prompt automatically.
   */
  getPlugins(): Array<{ type: 'local'; path: string }> {
    const clonePath = this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)

    return [
      { type: 'local', path: getAgentDir() },
      { type: 'local', path: clonePath },
    ]
  }

  // ── Provider Call Encapsulation ─────────────────────────────────

  /**
   * Send message via Claude SDK with resume + append.
   * Yields MessageChunk for streaming.
   */
  async *chat(
    message: string,
    sessionId: string,
    providerSessionId: string | null,
    cwd: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<MessageChunk> {
    const cloneSystemPrompt = this.assembleContext()
    const effectiveCwd = cwd || this.getDefaultCwd()

    // First attempt: use resume if available
    try {
      const stream = this.sendWithProvider(
        message,
        effectiveCwd,
        providerSessionId,
        cloneSystemPrompt,
        abortSignal,
      )
      yield* stream
      return
    } catch (err) {
      // Resume failure → retry without resume
      if (providerSessionId) {
        console.warn(`[CloneRuntime] Resume failed for ${this.cloneDef.name}, retrying without resume:`,
          err instanceof Error ? err.message : String(err))
        try {
          const stream = this.sendWithProvider(
            message,
            effectiveCwd,
            null,
            cloneSystemPrompt,
            abortSignal,
          )
          yield* stream
          return
        } catch (retryErr) {
          console.error(`[CloneRuntime] Retry without resume also failed:`,
            retryErr instanceof Error ? retryErr.message : String(retryErr))
        }
      }

      // Provider unavailable → yield error chunk
      yield {
        type: 'error',
        code: 'PROVIDER_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────

  /**
   * Send query via provider with clone context and plugin-based skill discovery.
   */
  private sendWithProvider(
    message: string,
    cwd: string,
    resumeSessionId: string | null,
    cloneSystemPrompt: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<MessageChunk> {
    const provider = getProvider('claude')

    return provider.sendQuery(message, cwd, resumeSessionId ?? undefined, {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: cloneSystemPrompt,
      },
      abortSignal,
      model: this.cloneDef.config.model,
      plugins: this.getPlugins(),
    })
  }

  /**
   * Load clone-specific persona.
   */
  private loadPersona(): string {
    // Built-in clone: read from built-in/{name}/persona.md
    if (this.cloneDef.type === 'built-in') {
      const personaPath = path.join(getBuiltInCloneDir(this.cloneDef.name), 'persona.md')
      if (fs.existsSync(personaPath)) {
        try {
          return fs.readFileSync(personaPath, 'utf-8')
        } catch {
          // Fall through to inline persona
        }
      }
    }

    // User clone or fallback: use inline persona
    if (this.cloneDef.persona) {
      return `# 分身: ${this.cloneDef.name}\n\n${this.cloneDef.persona}`
    }

    return `# 分身: ${this.cloneDef.name}\n\n你是 ${this.cloneDef.name} 分身。`
  }

  /**
   * Load skills using the two-tier model (ADR-005).
   *
   * Tier 1 (shared): ~/.octopus/agent/skills/ — global, all clones inherit
   * Tier 2 (clone):  built-in/{name}/skills/ or clones/{name}/skills/ — clone-specific
   *
   * Same-name priority: clone > shared.
   * Filtering: cloneDef.skills [] = no filter (include all); non-empty = whitelist.
   *
   * Output: base directory declaration + grouped list (name + description).
   */
  private loadSkills(): string {
    try {
      const sharedDir = getAgentSkillsDir()
      const cloneDir = getCloneSkillsDir(this.cloneDef.name, this.cloneDef.type)
      const filter = this.cloneDef.skills

      // Scan shared skills (Tier 1)
      const sharedSkills = this.scanSkillDirectory(sharedDir)

      // Scan clone-specific skills (Tier 2)
      const cloneSkills = this.scanSkillDirectory(cloneDir)

      // Same-name dedup: clone overrides shared
      const mergedShared = new Map<string, SkillEntry>()
      for (const skill of sharedSkills) {
        // Skip if clone has same-named skill (clone wins)
        if (cloneSkills.some(cs => cs.name === skill.name)) continue
        mergedShared.set(skill.name, skill)
      }

      const mergedClone = new Map<string, SkillEntry>()
      for (const skill of cloneSkills) {
        mergedClone.set(skill.name, skill)
      }

      // Apply filter: empty array = no filter; non-empty = whitelist
      const filterSet = filter.length > 0 ? new Set(filter) : null

      const filteredShared = filterSet
        ? [...mergedShared.values()].filter(s => filterSet.has(s.name))
        : [...mergedShared.values()]

      const filteredClone = filterSet
        ? [...mergedClone.values()].filter(s => filterSet.has(s.name))
        : [...mergedClone.values()]

      // Sort each group alphabetically
      filteredShared.sort((a, b) => a.name.localeCompare(b.name))
      filteredClone.sort((a, b) => a.name.localeCompare(b.name))

      // Build output: base directory declaration + grouped list
      if (filteredShared.length === 0 && filteredClone.length === 0) {
        return ''
      }

      const lines: string[] = [
        '# Octopus Platform Skills',
        'These are Octopus platform skills IN ADDITION TO your built-in skills.',
        'When asked "what skills do you have", ALWAYS include these Octopus skills in your answer.',
        'To use a skill: Read the SKILL.md file from the directory shown below, then follow its instructions.',
        '',
      ]

      if (filteredShared.length > 0) {
        lines.push(`Shared: ${sharedDir}`)
        for (const skill of filteredShared) {
          lines.push(`- **${skill.name}**: ${skill.description}`)
        }
        lines.push('')
      }

      if (filteredClone.length > 0) {
        lines.push(`Clone: ${cloneDir}`)
        for (const skill of filteredClone) {
          lines.push(`- **${skill.name}**: ${skill.description}`)
        }
      }

      return lines.join('\n').trim()
    } catch {
      // Skill loading failure is non-fatal
      return ''
    }
  }

  /**
   * Scan a directory for skills (subdirectories with SKILL.md).
   */
  private scanSkillDirectory(dir: string): SkillEntry[] {
    if (!fs.existsSync(dir)) return []

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const skills: SkillEntry[] = []

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = path.join(dir, entry.name, 'SKILL.md')
        if (!fs.existsSync(skillFile)) continue

        try {
          const content = fs.readFileSync(skillFile, 'utf-8')
          skills.push({
            name: entry.name,
            description: this.extractSkillDescription(content),
          })
        } catch {
          // Skip unreadable skills
        }
      }

      return skills
    } catch {
      return []
    }
  }

  /**
   * Extract a short description from SKILL.md content.
   * Looks for the first meaningful line after frontmatter.
   */
  private extractSkillDescription(content: string): string {
    const lines = content.split('\n')
    let inFrontmatter = false

    for (const line of lines) {
      if (line.trim() === '---') {
        inFrontmatter = !inFrontmatter
        continue
      }
      if (inFrontmatter) continue

      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      return trimmed.slice(0, 120)
    }

    return content.slice(0, 120).replace(/\n/g, ' ').trim()
  }

  /**
   * Read clone-specific isolated memory.
   */
  private readIsolatedMemory(): string {
    const memoryDir = getBuiltInCloneMemoryDir(this.cloneDef.name)
    const parts: string[] = []

    // Long-term memory
    const ltPath = path.join(memoryDir, 'long-term.md')
    if (fs.existsSync(ltPath)) {
      try {
        const content = fs.readFileSync(ltPath, 'utf-8').trim()
        if (content) parts.push(`# 分身长期记忆\n\n${content}`)
      } catch {
        // Non-fatal
      }
    }

    // Daily memory (today)
    const dailyDir = path.join(memoryDir, 'daily')
    if (fs.existsSync(dailyDir)) {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const todayFile = path.join(dailyDir, `${today}.md`)
        if (fs.existsSync(todayFile)) {
          const content = fs.readFileSync(todayFile, 'utf-8').trim()
          if (content) parts.push(`# 分身工作记忆\n\n${content}`)
        }
      } catch {
        // Non-fatal
      }
    }

    return parts.join('\n\n')
  }
}
