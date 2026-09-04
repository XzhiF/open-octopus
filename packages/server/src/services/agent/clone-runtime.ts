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
import type { MessageChunk, OctopusAgentDef } from '@octopus/providers'
import { getProvider } from '@octopus/providers'
import type { CloneDef } from '@octopus/shared'
import {
  getAgentDir,
  getAgentSkillsDir,
  getLongTermMemoryPath,
  getDailyMemoryDir,
  getBuiltInCloneDir,
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
    this.ensureDirectories()
  }

  // ── Directory Initialization ──────────────────────────────────────

  /**
   * Ensure clone's memory/ and skills/ directories exist.
   * Defensive — runs on every construction, idempotent.
   */
  private ensureDirectories(): void {
    try {
      const clonePath = this.cloneDef.type === 'built-in'
        ? getBuiltInCloneDir(this.cloneDef.name)
        : getCloneDir(this.cloneDef.name)

      const memoryDir = path.join(clonePath, 'memory')
      const skillsDir = path.join(clonePath, 'skills')
      const dailyDir = path.join(memoryDir, 'daily')

      if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true })
      if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true })
      if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true })
    } catch {
      // Directory creation failure is non-fatal
    }
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

    // 3. Clone's own memory (always loaded, regardless of memoryScope)
    const ownMemory = this.readOwnMemory()
    if (ownMemory) {
      segments.push(ownMemory)
    }

    // 4. Memory & persona management guidance
    const guidance = this.getMemoryGuidance()
    if (guidance) {
      segments.push(guidance)
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
   * Write to clone's own memory (daily log).
   * Supports optional mtime-based conflict detection (same pattern as main agent's writeMemory).
   *
   * @param content Memory content to append
   * @param expectedLastModified Optional ISO timestamp. If provided and the file has been
   *   modified since this timestamp, throws MEMORY_CONFLICT.
   */
  writeIsolatedMemory(content: string, expectedLastModified?: string): void {
    try {
      const clonePath = this.cloneDef.type === 'built-in'
        ? getBuiltInCloneDir(this.cloneDef.name)
        : getCloneDir(this.cloneDef.name)
      const memoryDir = path.join(clonePath, 'memory')
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true })
      }

      const today = new Date().toISOString().slice(0, 10)
      const filePath = path.join(memoryDir, 'daily', `${today}.md`)
      const dailyDir = path.dirname(filePath)
      if (!fs.existsSync(dailyDir)) {
        fs.mkdirSync(dailyDir, { recursive: true })
      }

      // Conflict detection: check if file was modified since client last read it
      if (expectedLastModified && fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        const serverModified = stat.mtime.toISOString()
        if (new Date(serverModified).getTime() > new Date(expectedLastModified).getTime()) {
          const err = new Error('Memory was modified by another process. Please reload and try again.') as Error & { code: string }
          err.code = 'MEMORY_CONFLICT'
          throw err
        }
      }

      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
      const time = new Date().toTimeString().split(' ')[0]
      fs.writeFileSync(filePath, `${existing}\n### ${time}\n${content}\n`, 'utf-8')
    } catch (err) {
      if ((err as { code?: string }).code === 'MEMORY_CONFLICT') {
        throw err  // Re-throw conflict errors to caller
      }
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
   *
   * 03 (task-authoring-v3, AC5): an optional `taskHomePath` appends a THIRD
   * plugin directory — the per-task home (`~/.octopus/tasks/{id}/`). The SDK
   * scans `{taskHomePath}/skills/`, which is where PluginMaterializer linked
   * the task's selected Skill-group skills (ADR-0010). Only the task-author
   * send path passes this (AC6 — routes/clone/index.ts); other clones omit it
   * and get the original 2-plugin behavior. Param is tail-appended so every
   * existing caller (clone/index.ts, main-agent-route.ts, tests) keeps working
   * unchanged (SW-BP15). Falsy (`undefined`/`""`) → no third plugin (no cwd
   * root scan).
   */
  getPlugins(taskHomePath?: string): Array<{ type: 'local'; path: string }> {
    const clonePath = this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)

    const plugins: Array<{ type: 'local'; path: string }> = [
      { type: 'local', path: getAgentDir() },
      { type: 'local', path: clonePath },
    ]
    if (taskHomePath) {
      plugins.push({ type: 'local', path: taskHomePath })
    }
    return plugins
  }

  // ── Provider Call Encapsulation ─────────────────────────────────

  /**
   * Send message via Claude SDK with resume + append.
   * Yields MessageChunk for streaming.
   *
   * 05 (SPIKE S1, v2-D7): `specUpdateNotice` is a transient, reverse-direction
   * notice set by TasksService.updateTask ([保存草稿]) and read by the
   * task-author clone chat send path. sendWithProvider appends it to the
   * system-prompt `append` string so the agent sees the user's spec override
   * on the next turn. assembleContext is fresh per turn (re-built at the top
   * of this method), so the notice is re-delivered only while the clone
   * route keeps it pending (it clears the notice after the stream). System-
   * prompt append (not prepend-to-user-msg) avoids DB + SDK history pollution
   * and the @@ token being treated as an instruction.
   *
   * 07 (SG6, v2-D8/D13): `authoringResourcesContent` is the draft-scope
   * SKILL.md content resolved from `tasks.authoring_resources[]` by
   * TaskAuthorSessionAugmenter (route-resolved per turn, since assembleContext
   * is fresh per turn — Mechanism B, SPIKE S2). sendWithProvider appends it
   * to the system-prompt `append` string ALONGSIDE specUpdateNotice. Only
   * skill-type authoring_resources are injected (agents/commands/rules are
   * workspace-scope → workflow.requires via SG7 materialize, not draft-scope).
   * For Claude SDK (task-author's provider), resume works natively — no
   * fresh-session / DB-history-prepend (the rejected Pi-only mechanism).
   *
   * Param order: `specUpdateNotice` then `authoringResourcesContent` sit before
   * `abortSignal` so the primary caller (clone/index.ts send path) reads
   * cleanly without an `undefined` hole. All existing callers pass ≤4 args,
   * so the reorder is backwards-compatible (verified: clone/index.ts:306,
   * main-agent-route.ts:239/763, clone-runtime.test.ts:168).
   *
   * 03 (task-authoring-v3, AC5): `taskHomePath` is appended AFTER `abortSignal`
   * (tail) — NOT before it — so the existing 4-7-arg callers (clone/index.ts
   * passes 6, main-agent-route passes 4, tests pass ≤6) are unchanged. Only
   * the task-author send path (routes/clone/index.ts AC6) passes the 8th arg.
   * sendWithProvider threads it to getPlugins(taskHomePath) which appends a
   * third plugin directory (the per-task home for materialized skill links).
   */
  async *chat(
    message: string,
    sessionId: string,
    providerSessionId: string | null,
    cwd: string,
    specUpdateNotice?: string,
    authoringResourcesContent?: string,
    abortSignal?: AbortSignal,
    taskHomePath?: string,
    modelOverride?: string,
    subagents?: Record<string, OctopusAgentDef>,
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
        specUpdateNotice,
        authoringResourcesContent,
        abortSignal,
        taskHomePath,
        modelOverride,
        subagents,
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
            specUpdateNotice,
            authoringResourcesContent,
            abortSignal,
            taskHomePath,
            modelOverride,
            subagents,
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
   * Send query via provider with clone context and plugin-based skill
   * discovery. 05 (SPIKE S1): `specUpdateNotice` is concatenated onto the
   * system-prompt `append` string (clone-runtime.ts:310-329) so the
   * task-author agent receives the user's [保存草稿] override in-context.
   * 07 (SG6): `authoringResourcesContent` is appended alongside the notice
   * so the task-author agent sees the current turn's authoring_resources[]
   * SKILL.md content. Concat order: cloneContext (base) → authoringResources
   * (skills) → specUpdateNotice (transient override) — skills land as part of
   * the base context, the notice lands as a trailing override.
   */
  private sendWithProvider(
    message: string,
    cwd: string,
    resumeSessionId: string | null,
    cloneSystemPrompt: string,
    specUpdateNotice: string | undefined,
    authoringResourcesContent: string | undefined,
    abortSignal?: AbortSignal,
    taskHomePath?: string,
    modelOverride?: string,
    subagents?: Record<string, OctopusAgentDef>,
  ): AsyncGenerator<MessageChunk> {
    const provider = getProvider('claude')

    // 05 — SPIKE S1: append the transient spec-update notice to the system
    // prompt. 07 — SG6: append authoring_resources SKILL.md content first
    // (so it's part of the base context), then the notice (trailing override).
    // Dynamic workspace state (org, projects, skill groups) lives in
    // `{taskHome}/context.md` — NOT in the system prompt. This keeps the
    // system prompt stable for prompt cache stability. The agent reads
    // context.md on demand when it sees @@context_updated.
    // Only concat when each piece is actually present; absent pieces leave no
    // stray separator (no @@ leak, no empty ## Available Skills section).
    const segments: string[] = [cloneSystemPrompt]
    if (authoringResourcesContent) {
      segments.push(authoringResourcesContent)
    }
    if (specUpdateNotice) {
      segments.push(specUpdateNotice)
    }
    const append = segments.filter(Boolean).join('\n\n')

    return provider.sendQuery(message, cwd, resumeSessionId ?? undefined, {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append,
      },
      abortSignal,
      model: modelOverride ?? this.cloneDef.config.model,
      agents: subagents,
      plugins: this.getPlugins(taskHomePath),
      // Path guard: for task-author sessions, block Write/Edit outside the
      // task home directory. This is a HARD enforcement — the agent CANNOT
      // write to the project codebase or other locations. Rules file is
      // advisory (agent can ignore); the hook is mandatory.
      onBeforeToolCall: taskHomePath
        ? buildPathGuard(taskHomePath)
        : undefined,
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
   * Read clone's own memory (long-term + daily).
   * Always loaded regardless of memoryScope — this is the clone's personal memory.
   */
  private readOwnMemory(): string {
    const clonePath = this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)
    const memoryDir = path.join(clonePath, 'memory')
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

  /**
   * Memory & persona management guidance injected into system prompt.
   * Tells the clone where to store memories and how to manage its persona.
   * Replaces the SDK's native memory system with file-based management.
   */
  private getMemoryGuidance(): string {
    const clonePath = this.cloneDef.type === 'built-in'
      ? getBuiltInCloneDir(this.cloneDef.name)
      : getCloneDir(this.cloneDef.name)
    const memoryDir = path.join(clonePath, 'memory')
    const skillsDir = path.join(clonePath, 'skills')
    const personaPath = path.join(clonePath, 'persona.md')

    return [
      '# 记忆与人格管理',
      '',
      '你拥有独立的文件管理系统来维护记忆和人格。请使用文件读写工具管理以下内容：',
      '',
      `## 目录结构`,
      `- 人格文件: \`${personaPath}\` — 你的身份和特质定义`,
      `- 长期记忆: \`${memoryDir}/long-term.md\` — 持久化的经验和偏好`,
      `- 每日记忆: \`${memoryDir}/daily/YYYY-MM-DD.md\` — 当天的工作记录`,
      `- 技能目录: \`${skillsDir}/\` — 你的专属技能`,
      '',
      `## 记忆操作指南`,
      `- 当用户要求"记住"或"写入记忆"时，将内容追加到 \`${memoryDir}/long-term.md\``,
      `- 每次对话中的重要发现，追加到今天的 daily 记忆文件`,
      `- 读取记忆时，优先读取上述文件路径`,
      '',
      '## record_daily 工具',
      '',
      '你可以使用 **record_daily** 工具记录重要的每日记忆。输入: { content: string }',
      '',
      '### 何时使用 record_daily (✅)',
      '- 用户揭示了偏好或工作模式',
      '- 做出了重要的决策或发现',
      '- 识别出了反复出现的问题模式',
      '- 建立了有效的工作流程',
      '',
      '### 何时不使用 record_daily (❌)',
      '- 简单的问候或寒暄',
      '- 没有持久价值的事实问答',
      '- 已经在记忆中的重复内容',
      '',
      `## 人格修改流程（重要）`,
      `当用户要求修改人格、角色、身份设定时，**必须按以下流程操作**：`,
      ``,
      `1. **先读取** \`${personaPath}\` 获取当前人格内容`,
      `2. **展示当前内容**给用户，并询问修改方式：`,
      `   - **覆盖**：用新内容完全替换当前人格`,
      `   - **追加**：在当前人格基础上增加新的特质或设定`,
      `   - **修改替换**：修改当前人格中的特定部分`,
      `3. **等待用户确认**具体的修改方式和内容后，再执行写入`,
      `4. 写入后，再次读取文件确认修改成功，并告知用户`,
      ``,
      `**注意：绝对不要在未读取当前内容、未询问用户意图的情况下直接覆盖 persona.md。**`,
    ].join('\n')
  }
}

/** Build an onBeforeToolCall callback that blocks file writes outside the
 *  task home directory. This is a HARD enforcement — unlike the rules file
 *  (advisory), the hook MANDATES compliance.
 *
 *  Allowed paths:
 *    - Inside task home (artifacts/, skills/, context.md, .claude/, etc.)
 *    - /tmp (scratch space; ticket 09 whitelist = task home + /tmp)
 *
 *  Blocked paths:
 *    - Any path outside the task home (project codebase, system dirs, etc.)
 *
 *  Read-only tools (Read, Glob, Grep, LS, etc.) are always allowed.
 *
 *  09 (task-phase-redesign, K17/AC2): Bash joins the intercepted set. Before
 *  this, `echo x > /anywhere` escaped the draft-session write lock entirely
 *  (gap proven by decisions/06 §1 — the guard only saw Write/Edit/NotebookEdit).
 *  The command string is statically scanned for write targets:
 *    redirects (`>`/`>>`/`N>`/`&>`/`&>>`, incl. quoted targets), `tee`,
 *    `sed -i`/`--in-place`, `dd of=`, `cp`/`mv` destinations,
 *    `git --git-dir=`/`--work-tree=` (spec's "`git --git-dir` 类").
 *  A target is ALLOWED iff it resolves inside task home (relative targets
 *  resolve against the home — task-author sessions run with cwd = task home,
 *  decisions/06 §1), /tmp (incl. macOS realpath /private/tmp), or a harmless
 *  /dev discard. Targets that cannot be resolved statically (`$HOME`,
 *  backticks, `$(…)`) are BLOCKED — conservative hard-guard posture.
 *  Known residual holes (defense-in-depth, not a sandbox): `cd /elsewhere &&
 *  echo x > rel`, and interpreter-internal writes (`python -c open(…)`). */
export function buildPathGuard(taskHomePath: string): (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined> {
  const normalizedHome = path.resolve(taskHomePath)

  return async (toolName: string, input: unknown): Promise<{ allow: boolean; reason?: string } | undefined> => {
    if (toolName === 'Bash') {
      return checkBashWriteGuard(input, normalizedHome)
    }

    // Only intercept file-write tools
    if (toolName !== 'Write' && toolName !== 'Edit' && toolName !== 'NotebookEdit') {
      return undefined // allow all other tools
    }

    const inp = input as Record<string, unknown>
    const filePath = (inp.file_path ?? inp.notebook_path) as string | undefined
    if (!filePath) return undefined // no path to check → allow

    const resolved = path.resolve(filePath)

    // Allow if inside the task home directory
    if (resolved === normalizedHome || resolved.startsWith(normalizedHome + path.sep)) {
      return undefined // allowed
    }

    // Blocked — provide a clear message so the agent redirects to artifacts/
    return {
      allow: false,
      reason: [
        `BLOCKED: "${filePath}" is outside the task workspace.`,
        ``,
        `Task home: ${normalizedHome}`,
        `Artifacts dir: ${path.join(normalizedHome, 'artifacts')}`,
        ``,
        `You MUST write all output files inside the task home directory.`,
        `- Formal artifacts → write to the artifacts/ subdirectory`,
        `- Working files (context, notes) → write to the task home root`,
        `- DO NOT write to the project codebase or any other location.`,
        ``,
        `Please redirect this write to the appropriate location inside the task home.`,
      ].join('\n'),
    }
  }
}

// ── Bash write-guard (ticket 09 / AC2) ──────────────────────────────

/** /tmp on macOS is a symlink to /private/tmp — both prefixes whitelist. */
const BASH_WRITE_TMP_DIRS = ['/tmp', '/private/tmp']

/** Harmless /dev discard/sink targets. */
const BASH_WRITE_DEV_ALLOW = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/zero', '/dev/urandom'])

/** Redirect capture: optional fd/& prefix, one or two `>`, then the target —
 *  double-quoted, single-quoted, or a bare token. The bare-token class
 *  excludes shell metacharacters and quote chars, so `2>&1` captures nothing
 *  (`&` can't start a token) and `> "/a b"` captures the quoted path.
 *  Scanned against the RAW command so `sh -c 'echo x > /elsewhere'` is caught
 *  too — nested quoted writes are exactly the bypass variants AC2 names. */
const REDIRECT_RE = /(?:[0-9*]?&?>{1,2})\s*("[^"]*"|'[^']*'|[^\s;&|()<>"'`]+)/g

/**
 * Split a command line into simple segments on `;`, `&&`, `||`, `|`, `&` and
 * newlines (quote-aware), then tokenize each segment on whitespace (quote
 * aware; quotes stripped — `wasQuoted` marks literals so `$VAR` inside single
 * quotes is still unresolvable-but-intentional… we block either way, keeping
 * the check simple).
 */
function segmentize(cmd: string): string[][] {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let tokenQuoted = false
  let quote: string | null = null
  let i = 0

  const pushToken = (): void => {
    if (token !== '') {
      current.push(token)
      token = ''
      tokenQuoted = false
    }
  }
  const pushSegment = (): void => {
    pushToken()
    if (current.length > 0) segments.push(current)
    current = []
  }

  while (i < cmd.length) {
    const ch = cmd[i]
    if (quote) {
      if (ch === '\\') { // backslash inside quotes: keep literal next char
        token += cmd[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
      } else {
        token += ch
        tokenQuoted = true
      }
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      tokenQuoted = true
      i++
      continue
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      token += cmd[i + 1]
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      pushToken()
      i++
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|') {
      // `||` collapses via the loop (second | → empty segment)
      pushSegment()
      i++
      continue
    }
    if (ch === '&') {
      // `&&` and background `&` — segment breaks; `>&` fd duplication must
      // NOT break: it only appears glued (`>&2`), handled before segmentizing
      // by leaving `>`… actually `>&` starts at `>`, and `>` falls through to
      // the default append below, so the `&` right after a captured target
      // would break the segment — fine, the target token already ended.
      pushSegment()
      i++
      continue
    }
    if (ch === '>' || ch === '<') {
      // redirect/heredoc operators are not part of tokens; the redirect scan
      // (REDIRECT_RE) handles targets. Per-segment arg scans look at command
      // words only. Glue the operator as its own token so arg scanners can
      // skip it safely.
      pushToken()
      let op = ch
      i++
      if (i < cmd.length && (cmd[i] === '>' || cmd[i] === '<')) { op += cmd[i]; i++ }
      if (i < cmd.length && cmd[i] === '&') { op += '&'; i++ } // >& / >>&
      current.push(op)
      continue
    }
    token += ch
    i++
  }
  pushSegment()
  return segments
}

/** True if a resolved absolute path is on the write whitelist. */
function isWhitelistedWritePath(absPath: string, normalizedHome: string): boolean {
  const r = path.resolve(absPath)
  if (r === normalizedHome || r.startsWith(normalizedHome + path.sep)) return true
  for (const t of BASH_WRITE_TMP_DIRS) {
    if (r === t || r.startsWith(t + '/')) return true
  }
  if (BASH_WRITE_DEV_ALLOW.has(r) || r.startsWith('/dev/fd/')) return true
  return false
}

/** Classify one extracted target. Returns null when the target is fine, or a
 *  human-readable problem string. */
function classifyWriteTarget(raw: string, normalizedHome: string): string | null {
  let t = raw.trim()
  // The redirect capture keeps the quotes it matched (`> "/a b"` → `"/a b"`) —
  // strip one layer so the path logic sees the real path.
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    t = t.slice(1, -1)
  }
  if (!t) return null
  // fd duplication (`>&2`, `>&1`) — no path involved.
  if (t.startsWith('&')) return null
  // Unresolvable: variable / command substitution / glob-heavy targets. The
  // agent can use an explicit path inside the task home or /tmp instead.
  if (/[$`]/.test(t)) {
    return `"${t}" 无法静态解析（含 $/反引号）— 不可证明它落在 task home 内`
  }
  // `~` expansion (home dir) — treat like an absolute: whitelisted only if it
  // happens to resolve inside task home or /tmp (it won't for ~user forms).
  const abs = t.startsWith('~') ? path.resolve(process.env.HOME ?? '', t.slice(1)) : t
  if (path.isAbsolute(abs)) {
    return isWhitelistedWritePath(abs, normalizedHome)
      ? null
      : `"${t}" 是 task home 之外的绝对路径`
  }
  // Relative → resolves against the session cwd, which IS the task home for
  // task-author draft sessions (decisions/06 §1).
  const resolvedRel = path.resolve(normalizedHome, t)
  return isWhitelistedWritePath(resolvedRel, normalizedHome)
    ? null
    : `"${t}" 从 task home 解析后越界（${resolvedRel}）`
}

/** Non-flag tokens of a segment (after skipping the command word itself),
 *  skipping env-assignment leading tokens (FOO=bar cmd …). */
function plainArgs(tokens: string[], skipFirstNonFlag: boolean): string[] {
  const args = tokens.slice(1)
  // drop leading VAR=value env assignments, shift the command window
  let start = 0
  while (start < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[start])) start++
  const rest = args.slice(start).filter((a) => !a.startsWith('-') && !/^[<>]/.test(a) && a !== '')
  return skipFirstNonFlag ? rest.slice(1) : rest
}

/** Extract write targets from one already-tokenized segment (command words). */
function segmentWriteTargets(tokens: string[]): string[] {
  // skip leading env assignments to find the command word
  let ci = 0
  while (ci < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[ci])) ci++
  const cmdWord = path.basename(tokens[ci] ?? '')
  const targets: string[] = []
  if (!cmdWord) return targets

  switch (cmdWord) {
    case 'tee':
      // tee [-a] file… — every non-flag arg is a write target
      targets.push(...plainArgs(tokens, false))
      break
    case 'sed': {
      const inPlace = tokens.some(
        (a) => /^-i($|[.=$])/.test(a) || a.startsWith('--in-place'),
      )
      if (!inPlace) break // plain `sed 's/x/y/' f` prints — not a write
      const usesE = tokens.some((a) => a === '-e' || a === '--expression')
      // without -e the first non-flag arg is the script; with -e, all are files
      targets.push(...plainArgs(tokens, !usesE))
      break
    }
    case 'cp':
    case 'mv':
    case 'install': {
      const args = plainArgs(tokens, false)
      if (args.length >= 1) targets.push(args[args.length - 1]) // destination
      break
    }
    case 'dd':
      for (const a of tokens.slice(1)) {
        if (a.startsWith('of=')) targets.push(a.slice(3))
      }
      break
    case 'git':
      for (let k = 1; k < tokens.length; k++) {
        const a = tokens[k]
        if ((a === '--git-dir' || a === '--work-tree' || a === '--work-tree=')) {
          if (tokens[k + 1]) targets.push(tokens[k + 1])
        } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
          targets.push(a.slice(a.indexOf('=') + 1))
        }
      }
      break
    default:
      break
  }
  return targets
}

/** The Bash branch of the path guard: collect every static write target of
 *  the command (redirects + write commands) and block on the first one that
 *  lands outside the whitelist. */
function checkBashWriteGuard(
  input: unknown,
  normalizedHome: string,
): { allow: boolean; reason?: string } | undefined {
  const inp = input as Record<string, unknown> | null
  const command = inp?.command
  if (typeof command !== 'string' || command === '') return undefined

  const offenders: string[] = []
  const report = (raw: string): void => {
    const problem = classifyWriteTarget(raw, normalizedHome)
    if (problem && !offenders.includes(problem)) offenders.push(problem)
  }

  // 1. Redirects — scan the RAW text (catches writes nested in sh -c '…').
  for (const m of command.matchAll(REDIRECT_RE)) {
    report(m[1])
  }

  // 2. Write commands with argument targets (tee/sed -i/dd/cp/mv/git).
  for (const tokens of segmentize(command)) {
    for (const t of segmentWriteTargets(tokens)) {
      report(t)
    }
  }

  if (offenders.length === 0) return undefined

  return {
    allow: false,
    reason: [
      `BLOCKED: this Bash command writes outside the task home.`,
      ``,
      ...offenders.map((o) => `  - ${o}`),
      ``,
      `Task home: ${normalizedHome}`,
      `Allowed write locations: task home (incl. artifacts/) and /tmp only.`,
      ``,
      `Rewrite the command to target a path inside the task home`,
      `(relative paths resolve from the home), or /tmp for scratch files.`,
      `Avoid $vars/backticks in write targets — use explicit paths.`,
    ].join('\n'),
  }
}
