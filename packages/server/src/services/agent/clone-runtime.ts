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
} from './paths'
import { getSkillLoader } from './skill-loader'

// ── Types ──────────────────────────────────────────────────────────

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

    // 4. Skills (global + clone-specific)
    const skills = this.loadSkills()
    if (skills) {
      segments.push(skills)
    }

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
    const agentDir = getAgentDir()
    const effectiveCwd = cwd || agentDir

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
   * Send query via provider with clone context appended.
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
      skills: this.cloneDef.skills,
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
   * Load skills: global skills + clone-specific skills.
   */
  private loadSkills(): string {
    try {
      const loader = getSkillLoader(this.org)
      const { content } = loader.buildPromptSegment(this.cloneDef.skills)
      return content
    } catch {
      // Skill loading failure is non-fatal
      return ''
    }
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
