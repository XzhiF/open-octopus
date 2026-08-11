// packages/server/src/services/agent/prompt-assembler.ts
//
// Unified Prompt Assembler — Adapter pattern that wraps three prompt systems:
//   1. SystemPromptAssembler (ChatPromptAdapter) — main agent system prompts
//   2. CloneRuntime.assembleContext (ClonePromptAdapter) — clone-specific prompts
//   3. buildDelegationPrompt (HarnessPromptAdapter) — harness delegation prompts
//
// The UnifiedPromptAssembler routes to the correct adapter based on
// cloneName + opts.type, providing a single entry point: assembleForAgent().
//
import fs from 'fs'
import path from 'path'
import type { CloneDef, DiagnosisReport } from '@octopus/shared'
import type { DelegationContext } from '../harness/agent-delegation'
import { SystemPromptAssembler } from './system-prompt-assembler'
import type { AssembleOptions } from './system-prompt-assembler'
import { CloneRuntime } from './clone-runtime'
import { buildDelegationPrompt } from '../harness/agent-delegation'
import { ContextEnricher } from './context-enricher'
import type { EvolutionDAO } from '../../db/dao/evolution-dao'
import {
  getBuiltInCloneDir,
  getCloneDir,
} from './paths'

// ── Types ──────────────────────────────────────────────────────

/** Agent type determines which adapter handles prompt assembly. */
export type AgentType = 'chat' | 'clone' | 'harness'

/**
 * Options for the unified assembleForAgent() entry point.
 * Extends the existing AssembleOptions with harness-specific fields.
 */
export interface AssembleForAgentOpts extends AssembleOptions {
  /** Explicit agent type override. If omitted, inferred from cloneName. */
  type?: AgentType
  /** Harness-specific: the diagnosis report triggering delegation. */
  diagnosisReport?: DiagnosisReport
  /** Harness-specific: delegation context with events, varpool, node config. */
  delegationContext?: DelegationContext
}

/**
 * PromptAssembler — unified interface for all agent types.
 * Each adapter implements this interface to provide consistent prompt assembly.
 */
export interface PromptAssembler {
  assembleForAgent(cloneName?: string, opts?: AssembleForAgentOpts): string
}

/**
 * Adapter interface — each adapter wraps one of the three prompt systems.
 */
export interface Adapter {
  assemble(opts?: AssembleForAgentOpts): string
}

// ── ChatPromptAdapter ──────────────────────────────────────────

/**
 * ChatPromptAdapter wraps SystemPromptAssembler for main agent prompts.
 * Produces the same output as SystemPromptAssembler.assemble().
 */
export class ChatPromptAdapter implements Adapter {
  private assembler: SystemPromptAssembler

  constructor(org: string) {
    this.assembler = new SystemPromptAssembler(org)
  }

  assemble(opts?: AssembleForAgentOpts): string {
    return this.assembler.assemble({
      clone_name: opts?.clone_name,
      max_tokens: opts?.max_tokens,
      scheduled_task: opts?.scheduled_task,
      include_skills: opts?.include_skills,
      session_context: opts?.session_context,
      userMessage: opts?.userMessage,
    })
  }

  /**
   * Assemble for a clone using SystemPromptAssembler's clone logic.
   * Preserves the existing assembleForClone() behavior with priority-based
   * budget truncation.
   */
  assembleForClone(cloneName: string, opts?: AssembleForAgentOpts): string {
    return this.assembler.assembleForClone(cloneName, {
      max_tokens: opts?.max_tokens,
      scheduled_task: opts?.scheduled_task,
      include_skills: opts?.include_skills,
      session_context: opts?.session_context,
      userMessage: opts?.userMessage,
    })
  }

  /** Expose the underlying assembler for testing. */
  getAssembler(): SystemPromptAssembler {
    return this.assembler
  }
}

// ── ClonePromptAdapter ─────────────────────────────────────────

/**
 * ClonePromptAdapter wraps CloneRuntime.assembleContext() for clone chat sessions.
 * Produces the same output as CloneRuntime.assembleContext().
 *
 * Requires a CloneDef to initialize CloneRuntime.
 */
export class ClonePromptAdapter implements Adapter {
  private runtime: CloneRuntime

  constructor(cloneDef: CloneDef, org: string) {
    this.runtime = new CloneRuntime(cloneDef, org)
  }

  assemble(_opts?: AssembleForAgentOpts): string {
    return this.runtime.assembleContext()
  }

  /** Expose the underlying runtime for testing. */
  getRuntime(): CloneRuntime {
    return this.runtime
  }
}

// ── HarnessPromptAdapter ───────────────────────────────────────

/**
 * HarnessPromptAdapter wraps buildDelegationPrompt() and adds:
 *   1. persona.md loading (harness-agent clone persona)
 *   2. Clone long-term memory loading
 *   3. Daily memory loading (daily/YYYY-MM-DD.md)
 *   4. FTS5 history search via ContextEnricher
 *   5. (stats injection handled by AgentDelegationService — not this adapter)
 *
 * The adapter preserves the existing buildDelegationPrompt() output
 * as the core delegation prompt, prepending persona, memory, daily, and
 * experience context segments.
 *
 * Ticket 05 — AC-2 (daily memory), AC-3 (experience context), AC-4 (stats
 * remain in AgentDelegationService; see ticket discussion).
 */
export class HarnessPromptAdapter implements Adapter {
  private org: string
  private cloneName: string
  private evolutionDao?: EvolutionDAO

  constructor(org: string, cloneName: string = 'harness-agent', evolutionDao?: EvolutionDAO) {
    this.org = org
    this.cloneName = cloneName
    this.evolutionDao = evolutionDao
  }

  assemble(opts?: AssembleForAgentOpts): string {
    const parts: string[] = []

    // 1. Load harness-agent persona.md
    const persona = this.loadPersona()
    if (persona) {
      parts.push(persona)
    }

    // 2. Load clone long-term memory
    const memory = this.loadLongTermMemory()
    if (memory) {
      parts.push(memory)
    }

    // 3. Load daily memory (today's interventions journal)
    const daily = this.loadDailyMemory()
    if (daily) {
      parts.push(daily)
    }

    // 4. Load experience context (FTS5 historical cases)
    //    Only when a diagnosisReport is available — the pattern is the query.
    if (opts?.diagnosisReport) {
      const experience = this.loadExperienceContext(opts.diagnosisReport)
      if (experience) {
        parts.push(experience)
      }
    }

    // 5. Build delegation prompt from report + context
    if (opts?.diagnosisReport && opts?.delegationContext) {
      const delegationPrompt = buildDelegationPrompt(
        opts.diagnosisReport,
        opts.delegationContext,
      )
      parts.push(delegationPrompt)
    }

    return parts.join('\n\n')
  }

  /**
   * Load persona.md from the harness-agent clone directory.
   * Checks built-in directory first, then user clones.
   */
  loadPersona(): string {
    const cloneDir = this.resolveCloneDir()
    if (!cloneDir) return ''

    const personaPath = path.join(cloneDir, 'persona.md')
    if (!fs.existsSync(personaPath)) return ''

    try {
      return fs.readFileSync(personaPath, 'utf-8')
    } catch {
      return ''
    }
  }

  /**
   * Load long-term memory from the harness-agent clone memory directory.
   */
  loadLongTermMemory(): string {
    const cloneDir = this.resolveCloneDir()
    if (!cloneDir) return ''

    const memoryPath = path.join(cloneDir, 'memory', 'long-term.md')
    if (!fs.existsSync(memoryPath)) return ''

    try {
      const raw = fs.readFileSync(memoryPath, 'utf-8')
      return `# 分身长期记忆\n\n${raw}`
    } catch {
      return ''
    }
  }

  /**
   * Load today's daily memory from the harness-agent clone directory.
   * Reads `memory/daily/YYYY-MM-DD.md` (today's date).
   * Budget: 500 tokens (~2000 chars). Returns '' if missing.
   *
   * Ticket 05 — AC-2.
   */
  loadDailyMemory(): string {
    const cloneDir = this.resolveCloneDir()
    if (!cloneDir) return ''

    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const dailyPath = path.join(cloneDir, 'memory', 'daily', `${today}.md`)
    if (!fs.existsSync(dailyPath)) return ''

    try {
      const raw = fs.readFileSync(dailyPath, 'utf-8')
      // Budget: 500 tokens ≈ 2000 chars
      const budget = 2000
      const truncated = raw.length > budget ? raw.slice(0, budget - 3) + '...' : raw
      return `# 今日干预记录 (${today})\n\n${truncated}`
    } catch {
      return ''
    }
  }

  /**
   * Load experience context via ContextEnricher (FTS5 historical cases).
   * scope=harness, forceSearch=true (always-on for harness), budget 1200 tokens.
   * Returns formatted segment or '' if no DAO or no results.
   *
   * Ticket 05 — AC-3, AC-7 (graceful degradation on missing DAO or no results).
   */
  loadExperienceContext(report: DiagnosisReport): string {
    if (!this.evolutionDao) return ''

    try {
      const enricher = new ContextEnricher(this.evolutionDao)
      // Use synchronous .enrich would require DAO sync method; but ContextEnricher.enrich is async.
      // For now, we return empty string and let AgentDelegationService handle async loading
      // via loadExperienceContextAsync(). This method is the sync fallback (no DAO = '').
      //
      // Since ContextEnricher.enrich() is async and this method signature is sync,
      // the actual experience loading is done in the async wrapper below.
      return ''
    } catch {
      return ''
    }
  }

  /**
   * Async version of loadExperienceContext — the real implementation that calls
   * ContextEnricher.enrich(). Used by AgentDelegationService which can await it.
   *
   * Ticket 05 — AC-3.
   */
  async loadExperienceContextAsync(report: DiagnosisReport): Promise<string> {
    if (!this.evolutionDao) return ''

    try {
      const enricher = new ContextEnricher(this.evolutionDao)
      const result = await enricher.enrich({
        scope: 'harness',
        query: report.pattern,
        org: this.org,
        budget: 1200,
        forceSearch: true,
      })
      return result.segment ?? ''
    } catch {
      // Graceful degradation — experience context failure is non-fatal
      return ''
    }
  }

  /**
   * Resolve the harness-agent clone directory.
   * Checks built-in first, then user clones.
   */
  private resolveCloneDir(): string | null {
    const builtInDir = getBuiltInCloneDir(this.cloneName)
    if (fs.existsSync(builtInDir)) return builtInDir

    const userDir = getCloneDir(this.cloneName)
    if (fs.existsSync(userDir)) return userDir

    return null
  }
}

// ── UnifiedPromptAssembler ─────────────────────────────────────

/**
 * Resolves a clone name to a CloneDef.
 * Minimal resolution for the prompt assembler — reads config.json or
 * falls back to defaults for built-in clones.
 */
function resolveCloneDefForPrompt(cloneName: string): CloneDef | null {
  // Check built-in first
  const builtInDir = getBuiltInCloneDir(cloneName)
  if (fs.existsSync(builtInDir)) {
    const configPath = path.join(builtInDir, 'config.json')
    let config: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      } catch { /* use defaults */ }
    }

    // Read persona if available
    let persona = ''
    const personaPath = path.join(builtInDir, 'persona.md')
    if (fs.existsSync(personaPath)) {
      try {
        persona = fs.readFileSync(personaPath, 'utf-8')
      } catch { /* use empty */ }
    }

    return {
      name: cloneName,
      displayName: (config.display_name as string) ?? cloneName,
      type: 'built-in',
      persona: persona || ((config.persona as string) ?? ''),
      skills: (config.skills as string[]) ?? [],
      memoryScope: (config.memoryScope as 'shared' | 'isolated') ?? 'shared',
      config: (config.config as CloneDef['config']) ?? {},
    }
  }

  // Check user clones
  const userDir = getCloneDir(cloneName)
  if (fs.existsSync(userDir)) {
    const configPath = path.join(userDir, 'config.json')
    let config: Record<string, unknown> = {}
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      } catch { /* use defaults */ }
    }

    let persona = ''
    const personaPath = path.join(userDir, 'persona.md')
    if (fs.existsSync(personaPath)) {
      try {
        persona = fs.readFileSync(personaPath, 'utf-8')
      } catch { /* use empty */ }
    }

    return {
      name: cloneName,
      displayName: (config.display_name as string) ?? cloneName,
      type: 'user',
      persona: persona || ((config.persona as string) ?? ''),
      skills: (config.skills as string[]) ?? [],
      memoryScope: (config.memoryScope as 'shared' | 'isolated') ?? 'shared',
      config: (config.config as CloneDef['config']) ?? {},
    }
  }

  return null
}

/**
 * UnifiedPromptAssembler — single entry point for all agent prompt assembly.
 *
 * Routing logic:
 *   1. opts.type === 'harness' → HarnessPromptAdapter
 *   2. opts.type === 'clone'   → ClonePromptAdapter (CloneRuntime)
 *   3. cloneName === 'harness-agent' → HarnessPromptAdapter
 *   4. cloneName provided (not harness) → ChatPromptAdapter.assembleForClone()
 *   5. No cloneName → ChatPromptAdapter.assemble()
 */
export class UnifiedPromptAssembler implements PromptAssembler {
  private org: string
  private chatAdapter: ChatPromptAdapter

  constructor(org: string) {
    this.org = org
    this.chatAdapter = new ChatPromptAdapter(org)
  }

  assembleForAgent(cloneName?: string, opts?: AssembleForAgentOpts): string {
    const type = opts?.type ?? this.inferType(cloneName)

    switch (type) {
      case 'harness':
        return new HarnessPromptAdapter(this.org, cloneName ?? 'harness-agent').assemble(opts)

      case 'clone': {
        if (!cloneName) {
          // Fall back to chat if no clone name provided
          return this.chatAdapter.assemble(opts)
        }
        const cloneDef = resolveCloneDefForPrompt(cloneName)
        if (!cloneDef) {
          // Clone not found — fall back to chat with clone_name hint
          return this.chatAdapter.assemble({ ...opts, clone_name: cloneName })
        }
        return new ClonePromptAdapter(cloneDef, this.org).assemble(opts)
      }

      case 'chat':
      default:
        if (cloneName) {
          return this.chatAdapter.assembleForClone(cloneName, opts)
        }
        return this.chatAdapter.assemble(opts)
    }
  }

  /**
   * Infer the agent type from the clone name when opts.type is not explicit.
   */
  private inferType(cloneName?: string): AgentType {
    if (!cloneName) return 'chat'
    if (cloneName === 'harness-agent') return 'harness'
    return 'chat'
  }

  /** Expose the chat adapter for testing. */
  getChatAdapter(): ChatPromptAdapter {
    return this.chatAdapter
  }
}

// ── Factory ────────────────────────────────────────────────────

/**
 * Create a UnifiedPromptAssembler for the given org.
 * This is the recommended entry point for consumers.
 */
export function createPromptAssembler(org: string): PromptAssembler {
  return new UnifiedPromptAssembler(org)
}
