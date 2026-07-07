import type {
  AgentSession,
  AgentMessage,
  AgentPaginatedResponse,
  MemoryContent,
  MemorySearchResult,
  CloneInfo,
  CreateCloneRequest,
  SkillInfo,
  EvolutionLogEntry,
  Experience,
  SafetyEvent,
  AgentRuntimeConfig,
  SafeModeStatus,
  TaskInfo,
  ScheduledJob,
  ReportInfo,
  DebugLogEntry,
  HealthStatus,
} from '@octopus/shared'

import { getSessionService } from './session-service'
import { getMemoryService } from './memory-service'
import { getEvolutionService } from './evolution-service'
import { getSubsystemAdapter } from './subsystem-adapter'
import { getConfigManager } from './config-manager'
import { AgentSessionDAO, SafetyDAO } from '../../db/dao'
import { SchedulerService } from '../scheduler/scheduler-service'
import { getRecoveryService } from './recovery-service'

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import {
  getAgentMemoryDir,
  getDailyMemoryDir,
  getLongTermMemoryPath,
  getAgentSkillsDir,
  getReportsDir,
  getDebugTracesDir,
  getClonesDir,
  getCloneDir,
} from './paths'

// ── Errors ────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} not implemented yet`)
    this.name = 'NotImplementedError'
  }
}

// ── Active Stream Registry (M7: stop generation) ────────────────────

const activeStreams = new Map<string, { abort: () => void; startedAt: number }>()

export function registerActiveStream(sessionId: string, abort: () => void): void {
  activeStreams.set(sessionId, { abort, startedAt: Date.now() })
}

export function unregisterActiveStream(sessionId: string): void {
  activeStreams.delete(sessionId)
}

export function isStreamActive(sessionId: string): boolean {
  return activeStreams.has(sessionId)
}

// ── AgentService ─────────────────────────────────────────────────

export class AgentService {
  private sessionDao: AgentSessionDAO
  private safetyDao: SafetyDAO
  private schedulerService: SchedulerService | null = null

  constructor(sessionDao: AgentSessionDAO, safetyDao: SafetyDAO) {
    this.sessionDao = sessionDao
    this.safetyDao = safetyDao
  }

  setSchedulerService(svc: SchedulerService): void {
    this.schedulerService = svc
  }
  // ── Sessions ──────────────────────────────────────────────────

  async createSession(
    org: string,
    opts?: { clone_name?: string },
  ): Promise<AgentSession> {
    return getSessionService().createSession(org, opts)
  }

  async listSessions(
    org: string,
    query?: { clone?: string; session_type?: string; limit?: number; cursor?: string },
  ): Promise<AgentPaginatedResponse<AgentSession>> {
    return getSessionService().listSessions(org, query)
  }

  async getSession(
    org: string,
    id: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<{ session: AgentSession; messages: AgentPaginatedResponse<AgentMessage> }> {
    const session = getSessionService().getSession(org, id)
    if (!session) {
      throw Object.assign(new Error(`Session ${id} not found`), { code: 'NOT_FOUND' })
    }

    const dao = this.sessionDao
    const limit = Math.min(query?.limit ?? 50, 200)
    const cursor = query?.cursor

    const rows = dao.findMessagesBySessionWithCursor(id, limit + 1, cursor)

    const hasMore = rows.length > limit
    const slicedRows = hasMore ? rows.slice(0, limit) : rows
    const messages = slicedRows.reverse().map((r) => ({
      id: r.id,
      session_id: r.session_id,
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null,
      is_summary: r.is_summary === 1,
      is_compressed: r.is_compressed === 1,
      created_at: r.created_at,
    }))

    return {
      session,
      messages: {
        items: messages,
        total: messages.length,
        has_more: hasMore,
        next_cursor: hasMore ? rows[limit - 1]?.created_at : null,
      },
    }
  }

  async updateSession(org: string, id: string, data: { title: string }): Promise<void> {
    const updated = getSessionService().updateSession(org, id, data)
    if (!updated) {
      throw Object.assign(new Error(`Session ${id} not found`), { code: 'NOT_FOUND' })
    }
  }

  async deleteSession(org: string, id: string): Promise<void> {
    const deleted = getSessionService().deleteSession(org, id)
    if (!deleted) {
      throw Object.assign(new Error(`Session ${id} not found`), { code: 'NOT_FOUND' })
    }
  }

  async stopChat(
    org: string,
    sessionId: string,
  ): Promise<{ partial_content_preserved: boolean }> {
    const stream = activeStreams.get(sessionId)
    if (stream) {
      stream.abort()
      activeStreams.delete(sessionId)
      return { partial_content_preserved: true }
    }
    return { partial_content_preserved: false }
  }

  // ── Memory ────────────────────────────────────────────────────

  async getMemory(
    org: string,
    layer: string,
    query?: { clone?: string; date?: string },
  ): Promise<MemoryContent | MemoryContent[]> {
    const memService = getMemoryService()
    if (layer === 'long-term') {
      const content = memService.readLongTerm(org)
      return { layer: 'long-term', content, token_count: Math.ceil(content.length / 4) }
    }
    if (layer === 'work') {
      const content = memService.readRecentWorkMemory(org, 3)
      return { layer: 'work', content, token_count: Math.ceil(content.length / 4) }
    }
    return { layer, content: '', token_count: 0 }
  }

  async addMemory(
    org: string,
    data: { layer: string; content: string; clone_name?: string },
  ): Promise<{ token_count: number }> {
    const memService = getMemoryService()
    memService.appendWorkMemory(org, {
      timestamp: new Date().toISOString(),
      task: data.layer,
      result: data.content,
    })
    return { token_count: Math.ceil(data.content.length / 4) }
  }

  async searchMemory(
    org: string,
    q: string,
    limit?: number,
  ): Promise<{ results: MemorySearchResult[]; degraded: boolean }> {
    const memService = getMemoryService()
    try {
      const results = memService.searchSessionMemory(org, q, limit ?? 3)
      return { results, degraded: false }
    } catch {
      return { results: [], degraded: true }
    }
  }

  async rebuildFts(org: string): Promise<{ indexed_count: number }> {
    return { indexed_count: 0 }
  }

  async archiveMemory(
    org: string,
    date?: string,
  ): Promise<{ archived_date: string; essence_summary: string }> {
    const targetDate = date ?? new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const memoryDir = getAgentMemoryDir()
    const dailyDir = path.join(memoryDir, 'daily')
    const archiveDir = path.join(dailyDir, 'archive')
    const sourceFile = path.join(dailyDir, `${targetDate}.md`)

    if (!fs.existsSync(sourceFile)) {
      throw Object.assign(new Error(`Daily memory for ${targetDate} not found`), { code: 'NOT_FOUND' })
    }

    fs.mkdirSync(archiveDir, { recursive: true })
    const content = fs.readFileSync(sourceFile, 'utf-8')
    fs.copyFileSync(sourceFile, path.join(archiveDir, `${targetDate}.md`))
    fs.unlinkSync(sourceFile)

    // P2.6: emit memory.archived domain event
    try {
      const { getDomainEventBus } = require('./domain-event-bus')
      const bus = getDomainEventBus()
      bus.emit('memory.archived', {
        memory_id: targetDate,
        memory_type: 'daily_memory',
        archived_at: new Date().toISOString(),
      }, { source: 'agent-service' }).catch(() => {})
    } catch {}

    return { archived_date: targetDate, essence_summary: content.slice(0, 500) }
  }

  // ── Clones ────────────────────────────────────────────────────

  async createClone(org: string, data: CreateCloneRequest): Promise<CloneInfo> {
    const clonesBaseDir = getClonesDir()
    const config = getConfigManager().getConfig(org)

    if (fs.existsSync(clonesBaseDir)) {
      const existing = fs.readdirSync(clonesBaseDir, { withFileTypes: true }).filter(e => e.isDirectory())
      if (existing.length >= config.max_clones) {
        throw Object.assign(new Error(`Maximum clones (${config.max_clones}) reached`), { code: 'MAX_CLONES_EXCEEDED' })
      }
    }

    fs.mkdirSync(clonesBaseDir, { recursive: true })
    const cloneDir = path.join(clonesBaseDir, data.name)
    fs.mkdirSync(cloneDir, { recursive: true })

    const meta = {
      name: data.name, org, workspace_id: null, workspace_path: null,
      status: 'idle', created_at: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(cloneDir, 'meta.json'), JSON.stringify(meta, null, 2))

    return {
      name: data.name, status: 'idle', workspace_name: null, workspace_exists: true,
      last_active_at: null, created_at: meta.created_at,
    }
  }

  async listClones(org: string): Promise<CloneInfo[]> {
    const clonesBaseDir = getClonesDir()
    const clones: CloneInfo[] = []

    if (fs.existsSync(clonesBaseDir)) {
      const entries = fs.readdirSync(clonesBaseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metaFile = path.join(clonesBaseDir, entry.name, 'meta.json')
          if (fs.existsSync(metaFile)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
              const wsPath = meta.workspace_path ?? meta.workspace_id
              clones.push({
                name: meta.name, status: meta.status, workspace_name: null,
                workspace_exists: wsPath ? fs.existsSync(wsPath) : true,
                last_active_at: meta.completed_at ?? null, created_at: meta.created_at,
              })
            } catch { /* skip */ }
          }
        }
      }
    }
    return clones
  }

  async deleteClone(org: string, name: string, keepWorkspace?: boolean): Promise<{ workspace_kept: boolean }> {
    const cloneDir = getCloneDir(name)
    if (!fs.existsSync(cloneDir)) {
      throw Object.assign(new Error(`Clone "${name}" not found`), { code: 'NOT_FOUND' })
    }
    const metaFile = path.join(cloneDir, 'meta.json')
    if (fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      if (meta.status === 'running') {
        throw Object.assign(new Error(`Clone "${name}" is running`), { code: 'CLONE_BUSY' })
      }
    }
    fs.rmSync(cloneDir, { recursive: true, force: true })
    return { workspace_kept: keepWorkspace ?? false }
  }

  async mergeClone(org: string, name: string): Promise<{ archived_lessons: number; clone_removed: boolean }> {
    const cloneDir = getCloneDir(name)
    if (!fs.existsSync(cloneDir)) {
      throw Object.assign(new Error(`Clone "${name}" not found`), { code: 'NOT_FOUND' })
    }

    let archivedLessons = 0
    const cloneMemoryDir = path.join(cloneDir, 'memory')
    if (fs.existsSync(cloneMemoryDir)) {
      const longTermFile = path.join(cloneMemoryDir, 'long-term.md')
      if (fs.existsSync(longTermFile)) {
        const content = fs.readFileSync(longTermFile, 'utf-8')
        const agentLtPath = getLongTermMemoryPath()
        const existing = fs.existsSync(agentLtPath) ? fs.readFileSync(agentLtPath, 'utf-8') : ''
        fs.writeFileSync(agentLtPath, `${existing}\n\n## 分身归档: ${name}\n${content}`, 'utf-8')
        archivedLessons = 1
      }
    }

    fs.rmSync(cloneDir, { recursive: true, force: true })
    return { archived_lessons: archivedLessons, clone_removed: true }
  }

  // ── Skills ────────────────────────────────────────────────────

  async listSkills(org: string): Promise<SkillInfo[]> {
    const adapter = getSubsystemAdapter(org)
    const skills = adapter.searchSkills('', 100)
    return skills.map(s => ({
      name: s.name, source: s.source, has_backup: false,
    }))
  }

  async getSkill(org: string, name: string): Promise<{
    name: string; source: string; content: string; token_count: number; last_modified: string | null
  }> {
    const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf-8')
      return { name, source: 'local_evolved', content, token_count: Math.ceil(content.length / 4), last_modified: null }
    }
    const builtinPath = path.join(process.cwd(), 'packages', 'core-pack', 'skills', name, 'SKILL.md')
    if (fs.existsSync(builtinPath)) {
      const content = fs.readFileSync(builtinPath, 'utf-8')
      return { name, source: 'builtin', content, token_count: Math.ceil(content.length / 4), last_modified: null }
    }
    throw Object.assign(new Error(`Skill "${name}" not found`), { code: 'NOT_FOUND' })
  }

  async getSkillDiff(org: string, name: string): Promise<{
    has_diff: boolean; diff: string | null; local_version: string | null; builtin_version: string | null
  }> {
    const builtinPath = path.join(process.cwd(), 'packages', 'core-pack', 'skills', name, 'SKILL.md')
    const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
    if (!fs.existsSync(builtinPath)) return { has_diff: false, diff: null, local_version: null, builtin_version: null }
    if (!fs.existsSync(localPath)) return { has_diff: false, diff: null, local_version: null, builtin_version: 'builtin' }
    const builtin = fs.readFileSync(builtinPath, 'utf-8')
    const local = fs.readFileSync(localPath, 'utf-8')
    return { has_diff: builtin !== local, diff: null, local_version: 'local', builtin_version: 'builtin' }
  }

  async revertToBuiltin(org: string, name: string): Promise<{ backup_created: string }> {
    const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath)
    return { backup_created: '' }
  }

  // ── Evolution ─────────────────────────────────────────────────

  async getChangelog(org: string, query?: { skill?: string; limit?: number; cursor?: string }): Promise<AgentPaginatedResponse<EvolutionLogEntry>> {
    const entries = getEvolutionService().listChangelog(org, { skill_name: query?.skill, limit: query?.limit })
    return { items: entries, total: entries.length, has_more: false, next_cursor: null }
  }

  async getExperiences(org: string, query?: { skill?: string; q?: string }): Promise<Experience[]> {
    return getEvolutionService().listExperiences(org, query?.skill)
  }

  async rollbackEvolution(org: string, id: number): Promise<{ rolled_back_skill: string; new_changelog_id: number }> {
    const success = getEvolutionService().rollback(org, id)
    if (!success) throw Object.assign(new Error(`Entry #${id} not found`), { code: 'NOT_FOUND' })
    return { rolled_back_skill: '', new_changelog_id: 0 }
  }

  // ── Tasks ─────────────────────────────────────────────────────

  async getTasks(org: string, history?: boolean): Promise<{ active: TaskInfo[]; scheduled: ScheduledJob[] }> {
    if (!this.schedulerService) return { active: [], scheduled: [] }
    const result = this.schedulerService.listJobs({ org })
    return { active: [], scheduled: result.items as unknown as ScheduledJob[] }
  }

  async cancelTask(org: string, id: string): Promise<void> {
    if (!this.schedulerService) throw new Error('Scheduler service not available')
    this.schedulerService.toggleJob(id)
  }

  async getReports(org: string, query?: { task?: string; date?: string; q?: string; limit?: number; cursor?: string }): Promise<AgentPaginatedResponse<ReportInfo>> {
    const reportsDir = getReportsDir()
    const items: ReportInfo[] = []

    if (fs.existsSync(reportsDir)) {
      // Scan task subdirectories: reports/{task_name}/{date}.md
      const taskDirs = fs.readdirSync(reportsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)

      for (const taskName of taskDirs) {
        const taskDir = path.join(reportsDir, taskName)
        const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.md'))
        for (const file of files) {
          const dateStr = file.replace('.md', '')
          const filePath = path.join(taskDir, file)

          // Apply filters
          if (query?.task && taskName !== query.task) continue
          if (query?.date && dateStr !== query.date) continue

          let status: 'ok' | 'missing' | 'rebuilt' = 'ok'
          let createdAt = ''
          try {
            const stat = fs.statSync(filePath)
            createdAt = stat.mtime.toISOString()
          } catch {
            status = 'missing'
            createdAt = new Date().toISOString()
          }

          // Content search filter
          if (query?.q) {
            try {
              const content = fs.readFileSync(filePath, 'utf-8')
              if (!content.toLowerCase().includes(query.q.toLowerCase())) continue
            } catch { continue }
          }

          items.push({
            id: `${taskName}/${dateStr}`,
            task_name: taskName,
            date: dateStr,
            file_path: filePath,
            status,
            created_at: createdAt,
          })
        }
      }

      // Also scan root-level reports (flat structure fallback)
      const rootFiles = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('.md'))
      for (const file of rootFiles) {
        const dateStr = file.replace('.md', '')
        const filePath = path.join(reportsDir, file)
        if (query?.date && dateStr !== query.date) continue
        if (query?.task) continue // root files have no task_name

        let createdAt = ''
        try {
          const stat = fs.statSync(filePath)
          createdAt = stat.mtime.toISOString()
        } catch { createdAt = new Date().toISOString() }

        if (query?.q) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8')
            if (!content.toLowerCase().includes(query.q.toLowerCase())) continue
          } catch { continue }
        }

        items.push({
          id: dateStr,
          task_name: 'general',
          date: dateStr,
          file_path: filePath,
          status: 'ok',
          created_at: createdAt,
        })
      }
    }

    // Sort by date descending
    items.sort((a, b) => b.date.localeCompare(a.date))

    const limit = query?.limit ?? 50
    const total = items.length
    const paged = items.slice(0, limit)

    return { items: paged, total, has_more: total > limit, next_cursor: total > limit ? paged[paged.length - 1].date : null }
  }

  async getReport(org: string, id: string): Promise<{ report: ReportInfo; content: string | null; rebuilt: boolean }> {
    const reportsDir = getReportsDir()
    // id format: "{task_name}/{date}" or "{date}"
    const filePath = path.join(reportsDir, id.endsWith('.md') ? id : `${id}.md`)

    if (!fs.existsSync(filePath)) {
      // Attempt rebuild from work memory (PRD E4: missing → degraded rebuild)
      const memService = getMemoryService()
      const workMemory = memService.readRecentWorkMemory(org, 7)
      if (workMemory) {
        const rebuiltContent = `# Report (Rebuilt from work memory)\n\n> Original report file missing. Rebuilt from recent work memory.\n\n${workMemory}`
        const report: ReportInfo = {
          id,
          task_name: id.split('/')[0] || 'general',
          date: id.split('/').pop() || new Date().toISOString().split('T')[0],
          file_path: filePath,
          status: 'rebuilt',
          created_at: new Date().toISOString(),
        }
        return { report, content: rebuiltContent, rebuilt: true }
      }
      throw Object.assign(new Error(`Report ${id} not found`), { code: 'NOT_FOUND' })
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const stat = fs.statSync(filePath)
    const report: ReportInfo = {
      id,
      task_name: id.split('/')[0] || 'general',
      date: id.split('/').pop()?.replace('.md', '') || '',
      file_path: filePath,
      status: 'ok',
      created_at: stat.mtime.toISOString(),
    }
    return { report, content, rebuilt: false }
  }

  // ── Config ────────────────────────────────────────────────────

  async getConfig(org: string): Promise<AgentRuntimeConfig & { config_degraded: boolean }> {
    const config = getConfigManager().getConfig(org)
    return { ...config, config_degraded: (config as { configDegraded?: boolean }).configDegraded ?? false }
  }

  async updateConfig(org: string, data: Partial<AgentRuntimeConfig>): Promise<{ config_degraded: boolean }> {
    getConfigManager().updateConfig(org, data)
    return { config_degraded: false }
  }

  // ── Safety ────────────────────────────────────────────────────

  async confirmSafety(org: string, eventId: string, decision: 'accept' | 'reject'): Promise<{ decision_applied: string }> {
    const dao = this.safetyDao
    const normalizedDecision = decision === 'accept' ? 'allow' : 'block'
    dao.updateSafetyEventDecision(Number(eventId), normalizedDecision)
    return { decision_applied: normalizedDecision }
  }

  async getSafetyEvents(org: string, query?: { type?: string; actor?: string; limit?: number; cursor?: string }): Promise<AgentPaginatedResponse<SafetyEvent>> {
    const dao = this.safetyDao
    const rows = dao.findSafetyEventsWithFilters(org, {
      type: query?.type,
      actor: query?.actor,
      limit: query?.limit,
    })
    return { items: rows, total: rows.length, has_more: false, next_cursor: null }
  }

  // ── Safe Mode ─────────────────────────────────────────────────

  async getSafeMode(org: string): Promise<SafeModeStatus> {
    const config = getConfigManager().getConfig(org)

    // Auto-check inactivity (PRD H2: auto-trigger based on inactive_days_threshold)
    if (!config.safe_mode.enabled) {
      const inactivity = getMemoryService().checkInactivitySafeMode(org)
      if (inactivity.should_enable) {
        // Auto-enable safe mode due to inactivity
        getConfigManager().updateConfig(org, {
          safe_mode: { enabled: true, inactive_days_threshold: 14 },
        } as Partial<AgentRuntimeConfig>)
        return {
          enabled: true,
          reason: `Auto-triggered: ${inactivity.days_inactive} days inactive (threshold: 14 days)`,
          triggered_at: new Date().toISOString(),
        }
      }
    }

    return {
      enabled: config.safe_mode.enabled,
      reason: config.safe_mode.enabled ? 'Manually enabled or auto-triggered by inactivity' : null,
      triggered_at: null,
    }
  }

  async enableSafeMode(org: string): Promise<SafeModeStatus> {
    getConfigManager().updateConfig(org, { safe_mode: { enabled: true, inactive_days_threshold: 14 } } as Partial<AgentRuntimeConfig>)
    return { enabled: true, reason: 'Manually enabled', triggered_at: new Date().toISOString() }
  }

  async disableSafeMode(org: string): Promise<SafeModeStatus> {
    getConfigManager().updateConfig(org, { safe_mode: { enabled: false, inactive_days_threshold: 14 } } as Partial<AgentRuntimeConfig>)
    return { enabled: false, reason: null, triggered_at: null }
  }

  // ── Debug ─────────────────────────────────────────────────────

  async getDebugLog(org: string, query?: { session_id?: string; limit?: number; cursor?: string }): Promise<AgentPaginatedResponse<{
    id: string; session_id: string; chat_id: string; timestamp: string; summary: string
  }>> {
    const debugDir = getDebugTracesDir()
    const items: Array<{ id: string; session_id: string; chat_id: string; timestamp: string; summary: string }> = []

    if (fs.existsSync(debugDir)) {
      const files = fs.readdirSync(debugDir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 5)
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(debugDir, file), 'utf-8')
          for (const line of content.split('\n').filter(Boolean)) {
            try {
              const entry = JSON.parse(line)
              items.push({
                id: entry.chat_id ?? crypto.randomUUID(),
                session_id: entry.session_id ?? '',
                chat_id: entry.chat_id ?? '',
                timestamp: entry.timestamp ?? '',
                summary: entry.message ?? '',
              })
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }
    }

    return { items, total: items.length, has_more: false, next_cursor: null }
  }

  async getAssembleDetail(org: string, chatId: string): Promise<DebugLogEntry> {
    const { SystemPromptAssembler } = await import('./system-prompt-assembler')
    const assembler = new SystemPromptAssembler(org)
    const segments = assembler.getSegments({ clone_name: undefined })
    return {
      chat_id: chatId,
      segments: segments.map((seg, idx) => ({
        index: idx,
        name: seg.name,
        token_count: seg.tokenEstimate,
        content: seg.content,
      })),
      total_tokens: segments.reduce((sum, seg) => sum + seg.tokenEstimate, 0),
    } as unknown as DebugLogEntry
  }

  // ── Health ────────────────────────────────────────────────────

  async getHealth(org: string): Promise<HealthStatus> {
    const recovery = getRecoveryService(org)
    return {
      status: 'ok',
      db: true,
      skills_loaded: 0,
      subsystems: {
        workflow_engine: true,
        workspace_service: true,
        scheduler_service: true,
        notify_subsystem: true,
        claude_provider: true,
      },
      safe_mode: false,
      recovery_needed: recovery.needsRecovery(),
      version: '1.0.0',
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let agentServiceInstance: AgentService | null = null

export function initAgentService(sessionDao: AgentSessionDAO, safetyDao: SafetyDAO): AgentService {
  agentServiceInstance = new AgentService(sessionDao, safetyDao)
  return agentServiceInstance
}

export function getAgentService(): AgentService {
  if (!agentServiceInstance) {
    throw new Error('AgentService not initialized. Call initAgentService() first.')
  }
  return agentServiceInstance
}
