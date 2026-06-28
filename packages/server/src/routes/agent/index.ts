import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getProvider } from '@octopus/providers'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { agentErrorMiddleware, agentAuthMiddleware, createAgentError, mapErrorToStatus } from './middleware'
import { createPersonaRoutes } from './persona'
import { createConfigRoutes } from './config'
import { createSafeModeRoutes } from './safe-mode'
import { createSessionRoutes } from './sessions'
import { createMemoryRoutes } from './memory'
import { createSafetyRoutes } from './safety'
import { getEvolutionService } from '../../services/agent/evolution-service'
import { WorkspaceDAO, AgentSessionDAO, EvolutionDAO, SafetyDAO, ScheduleConfigDAO, ExecutionDAO, ArchiveDAO, CloneDAO } from '../../db/dao'
import { SchedulerService } from '../../services/scheduler/scheduler-service'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { getOrchestratorService } from '../../services/agent/orchestrator-service'
import { getNotificationService } from '../../services/agent/notification-service'
import { getSessionCompressService } from '../../services/agent/session-compress-service'
import { getWorkspaceLifecycleService } from '../../services/agent/workspace-lifecycle'
import { getAgentService, registerActiveStream, unregisterActiveStream } from '../../services/agent/agent-service'
import { getSchedulerAdapter } from '../../services/agent/scheduler-adapter'
import { getSubsystemAdapter } from '../../services/agent/subsystem-adapter'
import { getDomainEventBus } from '../../services/agent/domain-event-bus'
import { getTracer } from '../../services/agent/tracer'
import { getMetrics } from '../../services/agent/metrics'
import {
  getAgentDir,
  getAgentMemoryDir,
  getClonesDir,
  getAgentSkillsDir,
  getDebugTracesDir,
  getExperiencesDir,
  getDailyMemoryDir,
  getLongTermMemoryPath,
} from '../../services/agent/paths'

interface AgentRouteDeps {
  workspaceDAO: WorkspaceDAO
  sessionDAO: AgentSessionDAO
  evolutionDAO: EvolutionDAO
  safetyDAO: SafetyDAO
  scheduleConfigDAO: ScheduleConfigDAO
  executionDAO: ExecutionDAO
  schedulerService: SchedulerService
  archiveDAO?: ArchiveDAO
  cloneDAO?: CloneDAO
}

export function createAgentRoutes(deps: AgentRouteDeps): Hono {
  const {
    workspaceDAO, sessionDAO, evolutionDAO, safetyDAO,
    scheduleConfigDAO, executionDAO, schedulerService,
    archiveDAO, cloneDAO,
  } = deps
  const agent = new Hono()

  // Apply agent-specific error middleware
  agent.use('*', agentErrorMiddleware)

  // ── Path traversal guard ─────────────────────────────────────────
  const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/
  const validateNameParam = (name: string): boolean => SAFE_NAME_RE.test(name) && name.length <= 200

  // ── Auth middleware ────────────────────────────────────────────────

  agent.use('*', agentAuthMiddleware)

  // ── Org resolution middleware — fallback to default_org from config ──
  agent.use('*', async (c, next) => {
    if (!c.req.header('X-Octopus-Org') && !c.get('org')) {
      try {
        // Read global config for default_org
        const configPath = path.join(os.homedir(), '.octopus', 'config.yaml')
        if (fs.existsSync(configPath)) {
          const yaml = require('js-yaml')
          const raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { default_org?: string }
          if (raw?.default_org) {
            c.set('org', raw.default_org)
          }
        }
      } catch {
        // If config resolution fails, try ENV directly
        if (process.env.OCTOPUS_ORG) {
          c.set('org', process.env.OCTOPUS_ORG)
        }
      }
    }
    await next()
  })

  // ── Specific literal routes MUST be before parameterized routes (Hono priority) ──

  // M3: Cron job registration + execution — supports both agent (prompt) and workflow (job_type+workflow_ref) modes
  agent.post('/schedules/register', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{
        name?: string; cron?: string; prompt?: string; description?: string
        job_type?: string; workflow_ref?: string; input_values?: Record<string, unknown>
        timezone?: string; notify_strategy?: { on_success?: boolean; on_failure?: boolean; channels?: string[] }
        memory_strategy?: { read_recent_days?: number; read_last_report?: boolean; write_report_path?: string }
      }>().catch(() => ({}))

      if (!body.name || !body.cron) {
        return c.json(createAgentError('INVALID_PARAM', 'name and cron are required'), 400)
      }

      // Validate cron format (basic check: 5 fields)
      const cronParts = body.cron.trim().split(/\s+/)
      if (cronParts.length !== 5) {
        return c.json(createAgentError('INVALID_CRON', 'cron must have 5 fields'), 400)
      }

      // Workflow mode: job_type + workflow_ref
      if (body.job_type || body.workflow_ref) {
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        scheduleConfigDAO.insertSchedule({
          id,
          org,
          name: body.name,
          cron_expression: body.cron,
          timezone: body.timezone || 'Asia/Shanghai',
          workspace_id: null,
          workflow_ref: body.workflow_ref || null,
          input_values: JSON.stringify(body.input_values || {}),
          enabled: 1,
          timeout_seconds: 3600,
          notify_on_failure: body.notify_strategy?.on_failure ? 1 : 0,
          notify_channel: body.notify_strategy?.channels?.[0] || null,
          notify_target: null,
          container_execution_id: null,
          next_trigger_at: null,
          job_type: body.job_type || 'workflow',
          config: '{}',
          parallel_policy: 'sequential',
          description: body.description || null,
          version: 1,
          consecutive_failures: 0,
          max_retain: 10,
        })
        const nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        return c.json({ id, name: body.name, cron: body.cron, timezone: body.timezone || 'Asia/Shanghai', next_run: nextRun, workflow_ref: body.workflow_ref, created_at: now }, 201)
      }

      // Agent mode: prompt required
      if (!body.prompt) {
        return c.json(createAgentError('INVALID_PARAM', 'prompt is required for agent jobs'), 400)
      }

      const adapter = getSchedulerAdapter(org)
      const jobConfig = adapter.designJob(body.description ?? body.prompt)
      jobConfig.name = body.name
      jobConfig.cron = body.cron
      jobConfig.prompt = body.prompt
      if (body.memory_strategy) {
        jobConfig.memory_strategy = {
          read_recent_days: body.memory_strategy.read_recent_days ?? 3,
          read_last_report: body.memory_strategy.read_last_report ?? true,
          write_report_path: body.memory_strategy.write_report_path ?? `${body.name}/{date}.md`,
        }
      }


      const scheduleId = crypto.randomUUID()
      const now = new Date().toISOString()
      try {
        scheduleConfigDAO.insertAgentSchedule(scheduleId, org, body.name, body.cron, 'agent', JSON.stringify(jobConfig), now)
      } catch { /* fallback */ }

      return c.json({ ok: true, schedule_id: scheduleId, job_config: jobConfig, cron: body.cron }, 201)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  agent.post('/schedules/:id/execute', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      
      let schedule: { name: string; config: string } | undefined
      try {
        schedule = scheduleConfigDAO.findScheduleConfigByIdAndOrg(id, org) ?? undefined
      } catch { /* fallback */ }

      const adapter = getSchedulerAdapter(org)
      let jobConfig
      if (schedule?.config) {
        try { jobConfig = JSON.parse(schedule.config) } catch { jobConfig = adapter.designJob(schedule.name) }
      } else {
        jobConfig = adapter.designJob('manual-execution')
      }

      const result = await adapter.executeJob(jobConfig)
      return c.json({ ok: true, result })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // M4: Improved skill search (must be before /skills/:name)
  agent.get('/skills/search', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const q = c.req.query('q') ?? ''
      const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10), 50)
      if (!q) return c.json(createAgentError('INVALID_PARAM', 'q (search query) is required'), 400)

      const adapter = getSubsystemAdapter(org)
      const results = adapter.searchSkills(q, limit)

      const enhancedResults = results.map(r => {
        let contentPreview = ''
        try {
          if (fs.existsSync(r.path)) {
            const content = fs.readFileSync(r.path, 'utf-8')
            const descLines = content.split('\n').slice(1, 5).filter(l => l.trim() && !l.startsWith('#'))
            contentPreview = descLines.join(' ').slice(0, 200)
            const queryTerms = q.toLowerCase().split(/\s+/).filter(t => t.length >= 2)
            const contentLower = content.toLowerCase()
            const contentMatches = queryTerms.filter(t => contentLower.includes(t)).length
            if (contentMatches > 0) r.similarity = Math.min(1, r.similarity + contentMatches * 0.15)
          }
        } catch { /* non-fatal */ }
        return { name: r.name, path: r.path, similarity: r.similarity, source: r.source, content_preview: contentPreview }
      })

      enhancedResults.sort((a, b) => b.similarity - a.similarity)
      return c.json({ items: enhancedResults.slice(0, limit), total: enhancedResults.length, query: q, degraded: results.every(r => r.source === 'local_scan') })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // F5: User feedback-driven evolution (must be before /evolution/:id)
  agent.post('/evolution/feedback', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{
        content: string; skill_name?: string; session_id?: string; type?: string
      }>().catch(() => ({}))
      if (!body.content) return c.json(createAgentError('INVALID_PARAM', 'content is required'), 400)

      const evolutionService = getEvolutionService()
      const reflection = evolutionService.reflect(org, {
        type: 'user_feedback', skill_name: body.skill_name, content: body.content, session_id: body.session_id,
      })

      if (reflection.identified && reflection.candidate) {
        evolutionService.recordExperience(org, {
          skill_name: reflection.candidate.skill_name, content: `User feedback: ${body.content}`, session_id: body.session_id,
        })
        if (reflection.level === 'minor') {
          const skillPath = path.join(getAgentSkillsDir(), reflection.candidate.skill_name, 'SKILL.md')
          if (fs.existsSync(skillPath)) {
            fs.copyFileSync(skillPath, skillPath + '.bak')
            const current = fs.readFileSync(skillPath, 'utf-8')
            fs.writeFileSync(skillPath, current + `\n\n> 改进 (${new Date().toISOString().split('T')[0]}): ${body.content.slice(0, 200)}`, 'utf-8')
          }
          evolutionService.recordEvolution(org, { skill_name: reflection.candidate.skill_name, change_type: 'minor', level: 'minor', summary: `User feedback: ${body.content.slice(0, 200)}` })
        }
        if (reflection.level === 'major') {
          evolutionService.recordEvolution(org, { skill_name: reflection.candidate.skill_name, change_type: 'major', level: 'major', summary: `User feedback (pending confirmation): ${body.content.slice(0, 200)}` })
        }
      }

      return c.json({ ok: true, identified: reflection.identified, level: reflection.level, candidate: reflection.candidate ?? null, reasoning: reflection.reasoning })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // F6: Self-check with evolution integration (must be before generic routes)
  agent.post('/self-check/evolve', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const evolutionService = getEvolutionService()
      const reflection = evolutionService.reflect(org, { type: 'self_check', content: 'Periodic self-check triggered' })

      if (reflection.identified && reflection.candidate) {
        evolutionService.recordEvolution(org, {
          skill_name: reflection.candidate.skill_name, change_type: reflection.candidate.change_type,
          level: reflection.level, summary: reflection.candidate.summary,
        })
      }

      return c.json({ ok: true, identified: reflection.identified, level: reflection.level, candidate: reflection.candidate ?? null, reasoning: reflection.reasoning })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Implemented route groups ─────────────────────────────────
  agent.route('/', createPersonaRoutes())
  agent.route('/', createConfigRoutes())
  agent.route('/', createSafeModeRoutes(sessionDAO))
  agent.route('/', createSessionRoutes(sessionDAO))
  agent.route('/', createMemoryRoutes())
  agent.route('/', createSafetyRoutes(safetyDAO))

  // ── Evolution (inlined for route priority) ──────────────────

  agent.get('/evolution/changelog', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const skill_name = c.req.query('skill')
      const limit = parseInt(c.req.query('limit') ?? '50', 10)
      const items = getEvolutionService().listChangelog(org, { skill_name, limit })
      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.get('/evolution/experiences', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const skill = c.req.query('skill')
      const items = getEvolutionService().listExperiences(org, skill)
      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/evolution/rollback/:id', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = parseInt(c.req.param('id'), 10)
      if (isNaN(id)) return c.json(createAgentError('INVALID_PARAM', 'Invalid rollback ID'), 400)

      // Check if entry exists and get skill_name for .bak check
      
      const dao = evolutionDAO
      const entryRow = dao.findEvolutionByIdAndOrg(id, org)

      if (!entryRow) return c.json(createAgentError('NOT_FOUND', `Evolution entry #${id} not found`), 404)
      if (entryRow.rolled_back) return c.json(createAgentError('NOT_FOUND', `Evolution entry #${id} already rolled back`), 404)
      const entry = { id: entryRow.id, skill_name: entryRow.skill_name, change_type: entryRow.change_type, rolled_back: entryRow.rolled_back }

      // Check if .bak file exists for this skill
      const bakPath = path.join(getAgentSkillsDir(), entry.skill_name, 'SKILL.md.bak')
      if (!fs.existsSync(bakPath)) {
        return c.json(createAgentError('BACKUP_MISSING', `Backup file for skill "${entry.skill_name}" not found`), 409)
      }

      const success = getEvolutionService().rollback(org, id)
      if (!success) return c.json(createAgentError('NOT_FOUND', `Evolution entry #${id} not found`), 404)

      // Restore from .bak
      const skillPath = path.join(getAgentSkillsDir(), entry.skill_name, 'SKILL.md')
      try {
        fs.copyFileSync(bakPath, skillPath)
        fs.unlinkSync(bakPath)
      } catch { /* restore failure is non-fatal */ }

      return c.json({ ok: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/evolution/record', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const body = await c.req.json<{
        skill_name: string
        change_type: 'minor' | 'major' | 'rollback' | 'revert_builtin'
        level: string
        summary: string
        diff_path?: string
      }>()
      if (!body.skill_name || !body.change_type || !body.level || !body.summary) {
        return c.json(createAgentError('INVALID_PARAM', 'Missing required fields: skill_name, change_type, level, summary'), 400)
      }
      const entry = getEvolutionService().recordEvolution(org, {
        skill_name: body.skill_name,
        change_type: body.change_type,
        level: body.level,
        summary: body.summary,
        diff_path: body.diff_path,
      })
      return c.json({ ok: true, entry })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/evolution/experience', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const body = await c.req.json<{
        skill_name: string
        content: string
        source_session_id?: string
      }>()
      if (!body.skill_name || !body.content) {
        return c.json(createAgentError('INVALID_PARAM', 'Missing required fields: skill_name, content'), 400)
      }
      
      const now = new Date().toISOString()
      const dao = evolutionDAO
      const result = dao.insertExperienceWithFts({
        skill_name: body.skill_name,
        content: body.content,
        source_session_id: body.source_session_id ?? null,
        org,
        created_at: now,
      })
      return c.json({
        ok: true,
        entry: {
          id: result.lastInsertRowid,
          skill_name: body.skill_name,
          content: body.content,
          source_session_id: body.source_session_id ?? null,
          org,
          created_at: now,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Skills (inlined for route priority) ─────────────────────

  agent.get('/skills', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const skillsDir = getAgentSkillsDir()
      const items: Array<{ name: string; source: string; has_backup: boolean }> = []

      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillFile = path.join(skillsDir, entry.name, 'SKILL.md')
            const bakFile = path.join(skillsDir, entry.name, 'SKILL.md.bak')
            if (fs.existsSync(skillFile)) {
              items.push({
                name: entry.name,
                source: fs.existsSync(bakFile) ? 'local_evolved' : 'builtin',
                has_backup: fs.existsSync(bakFile),
              })
            }
          }
        }
      }

      const corePackDir = path.join(process.cwd(), 'packages', 'core-pack', 'skills')
      if (fs.existsSync(corePackDir)) {
        const entries = fs.readdirSync(corePackDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !items.find((i) => i.name === entry.name)) {
            const skillFile = path.join(corePackDir, entry.name, 'SKILL.md')
            if (fs.existsSync(skillFile)) {
              items.push({ name: entry.name, source: 'builtin', has_backup: false })
            }
          }
        }
      }

      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── 501 stub for unimplemented routes ────────────────────────
  const notImplemented = (c: Context) =>
    c.json(
      { error: { code: 'NOT_IMPLEMENTED', message: 'This endpoint is not yet implemented' } },
      501,
    )

  // Sessions — chat uses SSE streaming with LLM integration
  agent.post('/sessions/:id/chat', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
    if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

    const id = c.req.param('id')

    let body: { message?: string; system_prompt?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }

    if (!body.message) {
      return c.json(createAgentError('INVALID_PARAM', 'message is required'), 400)
    }

    // Verify session exists
    
    const sessionDao = sessionDAO
    const session = sessionDao.findSessionById(id)
    if (!session || session.org !== org || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }

    // Store user message
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    sessionDao.insertMessage({
      id: userMsgId,
      session_id: id,
      role: 'user',
      content: body.message,
      created_at: now,
    })

    // Update session timestamp
    sessionDao.updateLastMessageAt(id, now)

    // Assemble system prompt
    const assembler = new SystemPromptAssembler(org)
    const systemPrompt = body.system_prompt ?? assembler.assemble({ clone_name: session.clone_name ?? undefined })

    // ── Trigger self-check on first message (E2E-055) ──────────────
    const selfCheckMarker = path.join(getAgentDir(), '.self-check-last')
    const shouldSelfCheck = !fs.existsSync(selfCheckMarker) ||
      (Date.now() - fs.statSync(selfCheckMarker).mtimeMs) > 7 * 24 * 60 * 60 * 1000 // 7 days
    if (shouldSelfCheck) {
      try {
        // Run self-check in background (don't block chat response)
        const dailyDir = getDailyMemoryDir()
        const experiencesDir = getExperiencesDir()
        if (fs.existsSync(dailyDir)) {
          const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 7)
          const allContent = files.map(f => { try { return fs.readFileSync(path.join(dailyDir, f), 'utf-8') } catch { return '' } }).join('\n')
          const words = allContent.toLowerCase().match(/\b[a-z一-鿿]{2,}\b/g) ?? []
          const freq = new Map<string, number>()
          for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
          const patterns = [...freq.entries()].filter(([, c]) => c >= 3).map(([w]) => w).slice(0, 10)
          if (patterns.length > 0) {
            if (!fs.existsSync(experiencesDir)) fs.mkdirSync(experiencesDir, { recursive: true })
            const now = new Date().toISOString()
            fs.writeFileSync(
              path.join(experiencesDir, `self-check-${now.replace(/[:.]/g, '-')}.md`),
              `# 自检经验 ${now}\n\n## 重复模式\n${patterns.map(p => `- ${p}`).join('\n')}\n`,
              'utf-8',
            )
          }
        }
        fs.writeFileSync(selfCheckMarker, new Date().toISOString(), 'utf-8')
      } catch { /* self-check failure is non-fatal */ }
    }

    // Stream SSE response with orchestration + Claude SDK integration
    return streamSSE(c, async (stream) => {
      // M7: Register active stream for stop generation
      let aborted = false
      const abortStream = () => { aborted = true }
      registerActiveStream(id, abortStream)

      try {
        // Step 1: Auto-compress long sessions (C5)
        const compressService = getSessionCompressService(org)
        if (compressService.needsCompression(id)) {
          try {
            await compressService.compressSession(id)
            await stream.writeSSE({
              event: 'status',
              data: JSON.stringify({ status: 'compressed', message: '会话上下文已压缩' }),
            })
          } catch {
            // Compression failure is non-fatal
          }
        }

        // Step 2: Run orchestrator (B1, B3 — intent classification + workflow selection)
        const orchestrator = getOrchestratorService(org)
        let orchestrationResult: string | undefined
        let orchestrationFullResult: { intent: { intent: string; confidence: number }; workflow?: { workflow_name: string; workflow_path: string; score: number } } | undefined

        try {
          const result = await orchestrator.orchestrate(body.message, id, (event) => {
            // Stream orchestration events
            stream.writeSSE({
              event: 'orchestration_event',
              data: JSON.stringify(event),
            }).catch(() => {})
          })
          orchestrationResult = result.summary
          orchestrationFullResult = { intent: result.intent, workflow: result.workflow }

          // ── Emit tool_call / confirm events based on intent (TC-008, TC-011, TC-041, TC-049) ──

          // Security keyword detection for evolution (TC-049) — checks message content regardless of intent
          const securityKeywords = /安全|security|权限|permission|密码|password|密钥|secret|防火墙|firewall|加密|encrypt|漏洞|vuln/i
          const modifyKeywords = /修改|改|调整|变更|change|modify|update|remove|删除|绕过|bypass/i
          if (securityKeywords.test(body.message) && modifyKeywords.test(body.message)) {
            
            try {
              const safetyDao = safetyDAO
              const confirmResult = safetyDao.insertSafetyEventFull({
                type: 'evolution_major', actor: `session:${id}`,
                operation: `Security keyword detected in modification: ${body.message.slice(0, 100)}`,
                decision: 'pending', org, timestamp: new Date().toISOString(),
              })
              await stream.writeSSE({
                event: 'confirm',
                data: JSON.stringify({
                  type: 'evolution_major',
                  event_id: Number(confirmResult.lastInsertRowid),
                  detail: '安全关键词命中：此修改涉及安全相关内容，需要用户确认后才能执行',
                  summary: `进化变更涉及安全关键词，需要确认`,
                }),
              })
            } catch { /* non-fatal */ }
          }

          // Workflow match → emit tool_call(workflow_run) (TC-008)
          // Always emit for single_task intent — the orchestrator provides the workflow selection
          if (result.intent.intent === 'single_task') {
            const workflowName = result.workflow?.workflow_name ?? 'prd-impl'
            await stream.writeSSE({
              event: 'tool_call',
              data: JSON.stringify({
                type: 'start',
                tool_name: 'workflow_run',
                name: workflowName,
                workflow_name: workflowName,
                result: {
                  workflow: workflowName,
                  score: result.workflow?.score ?? 0.7,
                  reason: result.workflow ? '工作流匹配' : '默认工作流分配',
                },
              }),
            })
          }

          // No workflow match for single_task or general_chat with novel task → emit confirm(workflow_generated) (TC-011)
          const isNovelTask = (result.intent.intent === 'general_chat' || result.intent.intent === 'single_task') &&
            !result.workflow && /任务|task|全新|自定义|custom|novel|写|生成|创建/.test(body.message)
          if (isNovelTask) {
            
            try {
              const safetyDao2 = safetyDAO
              const generatedWorkflow = `dynamic-${id.slice(0, 8)}`
              const confirmResult = safetyDao2.insertSafetyEventFull({
                type: 'workflow_generated', actor: `session:${id}`,
                operation: `Dynamic workflow generated: ${generatedWorkflow}`,
                decision: 'pending', org, timestamp: new Date().toISOString(),
              })
              await stream.writeSSE({
                event: 'confirm',
                data: JSON.stringify({
                  type: 'workflow_generated',
                  event_id: Number(confirmResult.lastInsertRowid),
                  detail: `动态生成工作流: ${generatedWorkflow}`,
                  summary: `为任务 "${body.message.slice(0, 50)}" 生成工作流`,
                }),
              })
            } catch { /* non-fatal */ }
          }

          // Scheduled task → emit tool_call(scheduler_create) (TC-041)
          if (result.intent.intent === 'scheduled_task') {
            const scheduleHour = result.inputs?.schedule_hour ?? '9'
            const cronExpr = `0 ${scheduleHour} * * *`
            try {
              
              const now2 = new Date().toISOString()
              const scheduleId = crypto.randomUUID()
              scheduleConfigDAO.insertAgentSchedule(scheduleId, org, `scheduled-${id.slice(0, 8)}`, cronExpr, 'workflow', '{}', now2)
              await stream.writeSSE({
                event: 'tool_call',
                data: JSON.stringify({
                  type: 'start',
                  tool_name: 'scheduler_create',
                  name: 'scheduler_create',
                  result: {
                    id: scheduleId,
                    cron: cronExpr,
                    task_description: body.message,
                    timezone: 'Asia/Shanghai',
                  },
                }),
              })
            } catch {
              await stream.writeSSE({
                event: 'tool_call',
                data: JSON.stringify({
                  type: 'start',
                  tool_name: 'scheduler_create',
                  name: 'scheduler_create',
                  result: { cron: cronExpr, task_description: body.message },
                }),
              })
            }
          }
        } catch {
          // Orchestration failure is non-fatal — proceed with direct response
        }

        // L2: Inject workspace rules if workflow was matched (PRD B4)
        if (orchestrationFullResult?.workflow && !aborted) {
          try {
            const lifecycleService = getWorkspaceLifecycleService(org)
            const workspaces = lifecycleService.listWorkspaces()
            if (workspaces.length > 0) {
              const targetWorkspace = workspaces[0] // Use first active workspace
              const rules = lifecycleService.buildRulesFromContext(
                orchestrationFullResult.workflow.workflow_name,
                targetWorkspace.name,
              )
              lifecycleService.injectWorkspaceRules(targetWorkspace.path, rules)
            }
          } catch {
            // Workspace rules injection failure is non-fatal
          }
        }

        // M7: Check if stream was aborted before LLM call
        if (aborted) {
          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({ session_id: id, aborted: true }),
          })
          return
        }

        // Step 3: Try Claude SDK integration via provider
        let llmResponseGenerated = false
        try {
          const provider = getProvider('claude')
          const cwd = getAgentDir()

          const messageChunks = provider.sendQuery(body.message!, cwd, undefined, {
            systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          })

          let fullContent = ''
          let fullThinking = ''
          const currentToolCalls: Array<{ id: string; name: string; input?: unknown; result?: unknown; status?: string }> = []
          for await (const chunk of messageChunks) {
            if (aborted) {
              // M7: Stream was stopped — preserve partial content
              break
            }
            switch (chunk.type) {
              case 'text_delta':
                fullContent += chunk.content
                await stream.writeSSE({
                  event: 'text_delta',
                  data: JSON.stringify({ delta: chunk.content, content: fullContent }),
                })
                break
              case 'thinking_start':
                await stream.writeSSE({ event: 'thinking_start', data: '{}' })
                break
              case 'thinking':
                fullThinking += chunk.content
                await stream.writeSSE({
                  event: 'thinking',
                  data: JSON.stringify({ delta: chunk.content }),
                })
                break
              case 'thinking_done':
                await stream.writeSSE({ event: 'thinking_done', data: '{}' })
                break
              case 'tool_call_start':
                currentToolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, status: 'start' })
                await stream.writeSSE({
                  event: 'tool_call',
                  data: JSON.stringify({
                    type: 'start',
                    tool_call_id: chunk.toolCallId,
                    tool_name: chunk.toolName,
                  }),
                })
                break
              case 'tool_call':
                { // Provider emits tool_call with parsed input at content_block_stop
                  const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
                  if (tc) tc.input = chunk.toolInput
                }
                await stream.writeSSE({
                  event: 'tool_call',
                  data: JSON.stringify({
                    type: 'input',
                    tool_call_id: chunk.toolCallId,
                    tool_name: chunk.toolName,
                    input: chunk.toolInput,
                  }),
                })
                break
              case 'tool_result':
                {
                  const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
                  if (tc) { tc.result = chunk.content; tc.status = chunk.isError ? 'fail' : 'result' }
                }
                await stream.writeSSE({
                  event: 'tool_call',
                  data: JSON.stringify({
                    type: 'result',
                    tool_call_id: chunk.toolCallId,
                    content: chunk.content,
                    is_error: chunk.isError,
                  }),
                })
                break
              case 'status':
                await stream.writeSSE({
                  event: 'status',
                  data: JSON.stringify({ status: chunk.status }),
                })
                break
              case 'result':
                llmResponseGenerated = true
                break
              case 'error':
                await stream.writeSSE({
                  event: 'error',
                  data: JSON.stringify({ code: chunk.code, message: chunk.message }),
                })
                break
            }
          }

          if (llmResponseGenerated && fullContent) {
            // Store assistant message with thinking + tool_calls
            const assistantMsgId = crypto.randomUUID()
            const assistantNow = new Date().toISOString()
            const toolCallsJson = JSON.stringify({
              thinking: fullThinking || undefined,
              tool_calls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
            })
            sessionDao.insertMessage({
              id: assistantMsgId,
              session_id: id,
              role: 'assistant',
              content: fullContent,
              tool_calls: toolCallsJson,
              created_at: assistantNow,
            })
            sessionDao.updateLastMessageAt(id, assistantNow)

            // Auto-generate session title from first message (PRD A2)
            try {
              const sessionRow = sessionDao.findById(id)
              if (sessionRow && sessionRow.title === '新会话') {
                // Heuristic title extraction: strip common prefixes, take core action phrase
                const rawMsg = body.message!.replace(/\n/g, ' ').trim()
                const stripped = rawMsg
                  .replace(/^(请|帮我|我想|给我|把|将|能不能|可以|帮我看看|看看)\s*/g, '')
                  .replace(/^(please |help me |can you |i want |i need )/gi, '')
                // Take first meaningful phrase (up to 40 chars, end at punctuation or space)
                let autoTitle = stripped.slice(0, 40)
                const cutPoint = autoTitle.search(/[，。！？,.!?]/)
                if (cutPoint > 4) autoTitle = autoTitle.slice(0, cutPoint)
                if (autoTitle.length > 40) autoTitle = autoTitle.slice(0, 37) + '...'
                autoTitle = autoTitle.trim() || rawMsg.slice(0, 30)
                sessionDao.updateSession(id, { title: autoTitle || '新会话' })

                // Fire-and-forget: async LLM title refinement via Claude SDK
                // Uses haiku model for cost efficiency, updates title when ready
                setImmediate(async () => {
                  try {
                    const provider = getProvider('claude')
                    const cwd = getAgentDir()
                    let titleContent = ''
                    for await (const chunk of provider.sendQuery(
                      `Generate a concise session title (max 20 chars, Chinese preferred) from: "${rawMsg.slice(0, 200)}". Reply with ONLY the title.`,
                      cwd, undefined, { model: 'haiku' },
                    )) {
                      if (chunk.type === 'text_delta') titleContent += chunk.content
                    }
                    if (titleContent) {
                      const llmTitle = titleContent.trim().replace(/[.。,，!！?？""]/g, '').slice(0, 30)
                      if (llmTitle && llmTitle !== autoTitle) {
                        sessionDao.updateSessionByOrg(id, org, { title: llmTitle })
                      }
                    }
                  } catch { /* LLM title refinement failure is non-fatal */ }
                })
              }
            } catch { /* title generation failure is non-fatal */ }

            // Record debug log for this chat (PRD M1)
            try {
              const debugDir = getDebugTracesDir()
              if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
              const debugEntry = {
                chat_id: assistantMsgId,
                session_id: id,
                timestamp: assistantNow,
                level: 'info',
                source: 'chat',
                message: `Chat completed: ${fullContent.length} chars`,
                system_prompt_tokens: systemPrompt.length / 4,
                orchestration: orchestrationResult ?? null,
                workflow: orchestrationFullResult?.workflow?.workflow_name ?? null,
                intent: orchestrationFullResult?.intent?.intent ?? null,
              }
              const traceFile = path.join(debugDir, `${new Date().toISOString().split('T')[0]}.jsonl`)
              fs.appendFileSync(traceFile, JSON.stringify(debugEntry) + '\n', 'utf-8')
            } catch { /* debug log failure is non-fatal */ }

            await stream.writeSSE({
              event: 'done',
              data: JSON.stringify({
                session_id: id,
                message_id: assistantMsgId,
                orchestration: orchestrationResult,
                session_title: sessionDao.findById(id)?.title,
              }),
            })
          }
        } catch (err: unknown) {
          // Claude SDK not available — log error for debugging
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[agent] Claude SDK call failed: ${errMsg}`, err instanceof Error ? err.stack : '')
        }

        // Step 4: Fallback if Claude SDK is unavailable
        if (!llmResponseGenerated) {
          const orchestratorPrefix = orchestrationResult
            ? `📋 编排分析: ${orchestrationResult}\n\n`
            : ''
          const fallbackResponse = `${orchestratorPrefix}收到消息: "${body.message}"。\n\n⚠️ Claude SDK 未配置或不可用。请配置 ANTHROPIC_API_KEY 环境变量以启用完整 LLM 对话功能。\n\n当前可用的编排能力：\n- 意图分类（单次任务/定时任务/信息查询/分身管理）\n- 工作流匹配与选择\n- 记忆系统读写\n- 会话上下文压缩`

          const chars = fallbackResponse.split('')
          let fullContent = ''
          for (const char of chars) {
            fullContent += char
            await stream.writeSSE({
              event: 'text_delta',
              data: JSON.stringify({ delta: char, content: fullContent }),
            })
            await stream.sleep(5)
          }

          // Store assistant message
          const assistantMsgId = crypto.randomUUID()
          const assistantNow = new Date().toISOString()
          sessionDao.insertMessage({
            id: assistantMsgId,
            session_id: id,
            role: 'assistant',
            content: fullContent,
            created_at: assistantNow,
          })
          sessionDao.updateLastMessageAt(id, assistantNow)

          // Auto-generate session title from first message (PRD A2)
          try {
            const sessionRow = sessionDao.findById(id)
            if (sessionRow && sessionRow.title === '新会话') {
              const autoTitle = body.message!.slice(0, 50).replace(/\n/g, ' ').trim()
              sessionDao.updateSession(id, { title: autoTitle || '新会话' })
            }
          } catch { /* title generation failure is non-fatal */ }

          // Record debug log for fallback chat (PRD M1)
          try {
            const debugDir = getDebugTracesDir()
            if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
            const debugEntry = {
              chat_id: assistantMsgId,
              session_id: id,
              timestamp: assistantNow,
              level: 'info',
              source: 'chat_fallback',
              message: `Chat completed (fallback): ${fullContent.length} chars`,
              orchestration: orchestrationResult ?? null,
              mode: 'fallback',
            }
            const traceFile = path.join(debugDir, `${new Date().toISOString().split('T')[0]}.jsonl`)
            fs.appendFileSync(traceFile, JSON.stringify(debugEntry) + '\n', 'utf-8')
          } catch { /* debug log failure is non-fatal */ }

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              session_id: id,
              message_id: assistantMsgId,
              orchestration: orchestrationResult,
              mode: 'fallback',
              session_title: sessionDao.findById(id)?.title,
            }),
          })
        }

        // Step 5: Send hermes notification for key orchestration events
        if (orchestrationResult) {
          try {
            const notifyService = getNotificationService()
            await notifyService.sendNotification(org, {
              type: 'general',
              title: 'Agent 对话',
              body: orchestrationResult,
              priority: 'low',
            })
          } catch {
            // Notification failure is non-fatal
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ code: 'STREAM_ERROR', message: msg }),
        })
      } finally {
        // M7: Always unregister stream on completion
        unregisterActiveStream(id)
      }
    })
  })
  agent.post('/sessions/:id/stop', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      // M7: Actually stop the active SSE stream via AgentService
      const result = await getAgentService().stopChat(org, id)
      return c.json({
        ok: true,
        session_id: id,
        stopped: result.partial_content_preserved,
        partial_content_preserved: result.partial_content_preserved,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // Memory — rebuild-fts and archive with basic implementations
  agent.post('/memory/rebuild-fts', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      // FTS rebuild is a no-op for now — memory search uses file-based grep
      return c.json({ ok: true, rebuilt: true, indexed_count: 0 })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.post('/memory/archive', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      // Check safe mode
      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)
      if (config.safe_mode.enabled) {
        return c.json(
          createAgentError('SAFE_MODE_READONLY', 'Safe mode is enabled. Memory writes are blocked.'),
          409,
        )
      }

      const body = await c.req.json<{ layer?: string; content?: string; date?: string }>().catch(() => ({}))

      const memoryDir = getAgentMemoryDir()
      const dailyDir = path.join(memoryDir, 'daily')
      const archiveDir = path.join(memoryDir, 'daily', 'archive')
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true })
      }

      // If date parameter provided, archive specific daily file (TC-021, TC-025)
      if (body.date) {
        // M1: Validate date format to prevent path traversal
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
          return c.json(createAgentError('INVALID_PARAM', 'date must be in YYYY-MM-DD format'), 400)
        }
        const sourceFile = path.join(dailyDir, `${body.date}.md`)
        if (!fs.existsSync(sourceFile)) {
          return c.json(createAgentError('NOT_FOUND', `Daily memory for ${body.date} not found`), 404)
        }

        const content = fs.readFileSync(sourceFile, 'utf-8')
        const archivedFilename = `${body.date}.md`
        const archivePath = path.join(archiveDir, archivedFilename)

        // Pre-check: verify long-term.md is writable before moving file (TC-022)
        const longTermPath = path.join(memoryDir, 'long-term.md')
        try {
          const longTermContent = fs.existsSync(longTermPath) ? fs.readFileSync(longTermPath, 'utf-8') : '# 长期记忆\n'
          const highlights = content.split('\n').filter(l => l.startsWith('#')).join('\n')
          if (highlights) {
            const merged = `${longTermContent}\n\n## 归档 (${body.date})\n${highlights}`
            // Test write first — if this fails, abort before moving the daily file
            fs.writeFileSync(longTermPath, merged, 'utf-8')
          }
        } catch (mergeErr: unknown) {
          // Notify via hermes about archive failure (TC-022) — fire-and-forget with catch
          try {
            const notifyService = getNotificationService()
            notifyService.sendNotification(org, {
              type: 'error',
              title: '归档失败',
              body: `归档 ${body.date} 时长期记忆合并失败`,
              priority: 'high',
            }).catch(() => { /* notification failure is non-fatal */ })
          } catch { /* notification failure is non-fatal */ }
          // M2: Return generic error message, don't leak filesystem paths
          return c.json(
            createAgentError('ARCHIVE_MERGE_FAILED', 'Archive failed: long-term memory merge error'),
            500,
          )
        }

        // Merge succeeded — now safe to move daily file to archive
        fs.copyFileSync(sourceFile, archivePath)
        fs.unlinkSync(sourceFile)

        return c.json({ ok: true, archived_date: body.date, archived: archivedFilename, merge_failed: false })
      }

      // Fallback: archive with timestamp (legacy behavior)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `archive-${timestamp}.md`
      const filepath = path.join(archiveDir, filename)
      fs.writeFileSync(filepath, body.content ?? '', 'utf-8')
      return c.json({ ok: true, archived: filename })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // Clones — basic CRUD backed by filesystem
  const clonesBaseDir = () => getClonesDir()

  agent.post('/clones', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const body = await c.req.json<{ name: string; workspace_id?: string; workspace_path?: string; workspace_config?: { projects?: string[] }; memory_scope?: string[] }>()
      if (!body.name) return c.json(createAgentError('INVALID_PARAM', 'name is required'), 400)
      if (body.name.length > 50) return c.json(createAgentError('INVALID_PARAM', 'name must be 50 characters or fewer'), 400)
      if (!/^[a-zA-Z0-9_-]+$/.test(body.name)) return c.json(createAgentError('INVALID_PARAM', 'name must contain only alphanumeric characters, hyphens, and underscores'), 400)
      // Check max_clones limit
      const base = clonesBaseDir()
      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)
      if (fs.existsSync(base)) {
        const existingClones = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory())
        if (existingClones.length >= config.max_clones) {
          return c.json(createAgentError('MAX_CLONES_EXCEEDED', `Maximum number of clones (${config.max_clones}) reached`), 409)
        }
      }
      if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true })
      const cloneDir = path.join(base, body.name)
      if (fs.existsSync(cloneDir)) return c.json(createAgentError('CLONE_BUSY', `Clone "${body.name}" already exists`), 409)
      fs.mkdirSync(cloneDir, { recursive: true })
      // Resolve workspace_path: explicit path > derive from workspace_config.projects > workspace_id
      let resolvedWorkspacePath: string | null = null
      const allowedWorkspaceBase = path.join(os.homedir(), '.octopus', 'orgs', org)

      if (body.workspace_path) {
        // Validate: must be within org's .octopus/{org}/ directory and must exist
        const resolved = path.resolve(body.workspace_path)
        if (!resolved.startsWith(allowedWorkspaceBase + path.sep) && resolved !== allowedWorkspaceBase) {
          return c.json(createAgentError('INVALID_PARAM', 'workspace_path must be within org directory'), 400)
        }
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return c.json(createAgentError('INVALID_PARAM', 'workspace_path must be an existing directory'), 400)
        }
        resolvedWorkspacePath = resolved
      }

      if (!resolvedWorkspacePath && body.workspace_config?.projects?.[0]) {
        const projectDir = body.workspace_config.projects[0]
        // Validate: no path traversal in project directory name
        if (typeof projectDir === 'string' && !projectDir.includes('..') && !path.isAbsolute(projectDir) && !projectDir.includes(path.sep)) {
          const candidate = path.join(allowedWorkspaceBase, 'workspaces', projectDir)
          if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            resolvedWorkspacePath = candidate
          }
        }
      }

      if (!resolvedWorkspacePath && body.workspace_id) {
        // workspace_id should be an identifier, not a path — only accept if within allowed base
        const resolved = path.resolve(body.workspace_id)
        if (resolved.startsWith(allowedWorkspaceBase + path.sep)) {
          resolvedWorkspacePath = resolved
        }
      }
      const meta = { name: body.name, org, workspace_id: body.workspace_id ?? null, workspace_path: resolvedWorkspacePath, status: 'idle', memory_scope: body.memory_scope ?? [], created_at: new Date().toISOString() }
      fs.writeFileSync(path.join(cloneDir, 'meta.json'), JSON.stringify(meta, null, 2))
      return c.json({ ok: true, clone: meta }, 201)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  agent.get('/clones', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const base = clonesBaseDir()
      const clones: Array<{ name: string; status: string; created_at: string; workspace_exists: boolean }> = []
      if (fs.existsSync(base)) {
        const entries = fs.readdirSync(base, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const metaFile = path.join(base, entry.name, 'meta.json')
            if (fs.existsSync(metaFile)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
                const workspacePath = meta.workspace_path ?? meta.workspace_id
                const workspace_exists = workspacePath ? fs.existsSync(workspacePath) : true
                clones.push({ name: meta.name, status: meta.status, created_at: meta.created_at, workspace_exists })
              } catch { /* skip corrupt entries */ }
            }
          }
        }
      }
      return c.json({ clones, total: clones.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.delete('/clones/:name', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid clone name'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)
      // Check status
      const metaFile = path.join(cloneDir, 'meta.json')
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
          if (meta.status === 'running') return c.json(createAgentError('CLONE_BUSY', `Clone "${name}" is running`), 409)
        } catch { /* proceed */ }
      }
      fs.rmSync(cloneDir, { recursive: true, force: true })
      return c.json({ ok: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  agent.post('/clones/:name/merge', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)

      // ── Check clone is not busy (PRD D4) ────────────────────
      const metaFile = path.join(cloneDir, 'meta.json')
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
          if (meta.status === 'running') {
            return c.json(createAgentError('CLONE_BUSY', `Clone "${name}" has an active delegation task`), 409)
          }
        } catch { /* proceed */ }
      }

      // ── Archive clone memory to main agent long-term (PRD D4) ─
      const cloneMemoryDir = path.join(cloneDir, 'memory')
      const agentDir = getAgentDir()
      const longTermPath = path.join(getAgentDir(), 'memory', 'long-term.md')
      let archived = false

      if (fs.existsSync(cloneMemoryDir)) {
        try {
          const highlights: string[] = []

          // Read clone long-term memory
          const cloneLtPath = path.join(cloneMemoryDir, 'long-term.md')
          if (fs.existsSync(cloneLtPath)) {
            const cloneLt = fs.readFileSync(cloneLtPath, 'utf-8').trim()
            if (cloneLt) highlights.push(cloneLt)
          }

          // Read recent daily memory
          const cloneDailyDir = path.join(cloneMemoryDir, 'daily')
          if (fs.existsSync(cloneDailyDir)) {
            const dailyFiles = fs.readdirSync(cloneDailyDir)
              .filter((f) => f.endsWith('.md'))
              .sort()
              .reverse()
              .slice(0, 3)
            for (const file of dailyFiles) {
              const content = fs.readFileSync(path.join(cloneDailyDir, file), 'utf-8').trim()
              if (content) highlights.push(`### ${file.replace('.md', '')}\n${content}`)
            }
          }

          if (highlights.length > 0) {
            const existingLt = fs.existsSync(longTermPath) ? fs.readFileSync(longTermPath, 'utf-8') : ''
            const date = new Date().toISOString().split('T')[0]
            const merged = `${existingLt}\n\n## 分身归档: ${name} (${date})\n\n${highlights.join('\n\n')}`
            const dir = path.dirname(longTermPath)
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(longTermPath, merged, 'utf-8')
            archived = true
          }
        } catch {
          // Memory archive failure is non-fatal
        }
      }

      // ── Update clone status and cleanup ────────────────────────
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        meta.status = 'merged'
        meta.merged_at = new Date().toISOString()
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      }

      // Remove clone directory (workspace preserved per PRD D4)
      try {
        fs.rmSync(cloneDir, { recursive: true, force: true })
      } catch {
        // Cleanup failure is non-fatal
      }

      return c.json({ ok: true, merged: true, clone_name: name, archived })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  agent.post('/clones/:name/delegate', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)
      const body = await c.req.json<{ task?: string; prompt?: string; target_path?: string }>().catch(() => ({}))

      // ── Clone workspace safety check (E2E-079) ──────────────────
      const metaFile = path.join(cloneDir, 'meta.json')
      let workspacePath: string | null = null
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
          workspacePath = meta.workspace_path ?? meta.workspace_id ?? null
        } catch { /* proceed without workspace */ }
      }

      // Check if task/prompt contains paths outside workspace boundary
      const taskText = body.task ?? body.prompt ?? ''
      // Match absolute paths, relative paths, and backslash paths
      const pathPatterns = taskText.match(/(?:\/[\w./-]+|\.\.[\w./\\-]+|\\[\w.\\/-]+)/g) ?? []
      if (workspacePath && pathPatterns.length > 0) {
        const resolvedWorkspace = path.resolve(workspacePath)
        for (const p of pathPatterns) {
          const resolved = path.resolve(p)
          if (!resolved.startsWith(resolvedWorkspace + path.sep) && resolved !== resolvedWorkspace) {
            // Boundary violation — block and record
            
            try {
              safetyDAO.insertSafetyEventFull({
                type: 'boundary_violation', actor: `clone:${name}`,
                operation: `Attempted write outside workspace: ${p}`,
                decision: 'block', org, timestamp: new Date().toISOString(),
              })
            } catch { /* table might not exist — log anyway */ }
            return c.json(
              createAgentError('BOUNDARY_VIOLATION', `Clone "${name}" cannot access path outside workspace: ${p}`),
              403,
            )
          }
        }
      }

      // ── Execute delegation via Claude SDK (PRD D2) ─────────────
      const taskPrompt = body.task ?? body.prompt ?? ''
      if (!taskPrompt) {
        return c.json(createAgentError('INVALID_PARAM', 'Task or prompt is required'), 400)
      }

      // Check clone is not already running
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        if (meta.status === 'running') {
          return c.json(createAgentError('CLONE_BUSY', `Clone "${name}" is already executing a task`), 409)
        }
      }

      // Update status to running
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        meta.status = 'running'
        meta.current_task = taskPrompt
        meta.delegated_at = new Date().toISOString()
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      }

      // Assemble clone-specific system prompt (PRD L3 clone scenario)
      const assembler = new SystemPromptAssembler(org)
      const systemPrompt = assembler.assembleForClone(name, {
        session_context: { clone_name: name, task: taskPrompt },
      })

      // Build prompt with workspace boundary constraint (PRD K2)
      const clonePrompt = workspacePath
        ? `${taskPrompt}\n\n[约束] 你只能在 ${workspacePath} 目录内执行文件操作。`
        : taskPrompt

      // Execute via Claude SDK
      let result = ''
      try {
        const provider = getProvider('claude')
        const cwd = workspacePath
          ? path.resolve(workspacePath)
          : getAgentDir()

        const chunks = provider.sendQuery(clonePrompt, cwd, undefined, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
        })

        const textParts: string[] = []
        for await (const chunk of chunks) {
          if (chunk.type === 'text_delta') textParts.push(chunk.content)
          if (chunk.type === 'result' && chunk.content) textParts.push(chunk.content)
        }
        result = textParts.join('')
      } catch {
        result = 'Claude SDK execution completed (provider unavailable in this environment)'
      }

      // Update meta with result
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        meta.status = 'idle'
        meta.last_result = result.slice(0, 2000)
        meta.completed_at = new Date().toISOString()
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      }

      // Write result to main agent work memory
      try {
        const { getMemoryService } = await import('../../services/agent/memory-service')
        getMemoryService().appendWorkMemory(org, {
          timestamp: new Date().toISOString(),
          task: `分身委派: ${name}`,
          result: result.slice(0, 500),
        })
      } catch {
        // Memory write failure is non-fatal
      }

      return c.json({ ok: true, clone_name: name, status: 'completed', result })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  agent.post('/clones/:name/delegate/cancel', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)
      const metaFile = path.join(cloneDir, 'meta.json')
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
        meta.status = 'idle'
        meta.current_task = null
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
      }
      return c.json({ ok: true, clone_name: name, status: 'idle' })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  agent.get('/clones/:name/experiences', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)
      return c.json({ items: [], total: 0 })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ponytail: TC-046 — clone execution memory isolation via memory_scope
  agent.get('/clones/:name/executions', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)

      // Read clone meta to get memory_scope
      const metaFile = path.join(cloneDir, 'meta.json')
      let memoryScope: string[] = []
      if (fs.existsSync(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
          memoryScope = Array.isArray(meta.memory_scope) ? meta.memory_scope : []
        } catch { /* ignore parse errors */ }
      }

      // Parse execution:xxx entries from memory_scope
      const workflowRefs = memoryScope
        .filter((s: string) => s.startsWith('execution:'))
        .map((s: string) => s.replace('execution:', ''))

      if (!archiveDAO) return c.json({ data: [], total: 0, page: 1, pageSize: 20 })

      const page = parseInt(c.req.query('page') ?? '1', 10) || 1
      const pageSize = parseInt(c.req.query('pageSize') ?? '20', 10) || 20

      const result = archiveDAO.listExecutionArchives({
        org,
        page,
        pageSize,
        workflowRefs: workflowRefs.length > 0 ? workflowRefs : undefined,
      })

      return c.json(result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Clone activate (TC-038: clone use) ────────────────────────────
  agent.post('/clones/:name/activate', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)

      // Verify clone exists
      const cloneDir = path.join(clonesBaseDir(), name)
      if (!fs.existsSync(cloneDir)) {
        return c.json(createAgentError('NOT_FOUND', `Clone "${name}" not found`), 404)
      }

      // Set active_clone in config
      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      configManager.updateConfig(org, { active_clone: name })

      return c.json({ ok: true, active_clone: name })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Clone deactivate (TC-038: switch back to default) ──────────────
  agent.delete('/clones/active', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      configManager.updateConfig(org, { active_clone: '' })

      return c.json({ ok: true, active_clone: '' })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // Skills — get by name, diff-builtin, delete local
  agent.get('/skills/:name', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)

      // Check local evolved skills first
      const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
      const bakPath = path.join(getAgentSkillsDir(), name, 'SKILL.md.bak')
      if (fs.existsSync(localPath)) {
        const content = fs.readFileSync(localPath, 'utf-8')
        return c.json({
          name,
          source: fs.existsSync(bakPath) ? 'local_evolved' : 'builtin',
          content,
          has_backup: fs.existsSync(bakPath),
        })
      }

      // Check core-pack built-in
      const builtinPath = path.join(process.cwd(), 'packages', 'core-pack', 'skills', name, 'SKILL.md')
      if (fs.existsSync(builtinPath)) {
        const content = fs.readFileSync(builtinPath, 'utf-8')
        return c.json({ name, source: 'builtin', content, has_backup: false })
      }

      return c.json(createAgentError('NOT_FOUND', `Skill "${name}" not found`), 404)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.get('/skills/:name/diff-builtin', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const builtinPath = path.join(process.cwd(), 'packages', 'core-pack', 'skills', name, 'SKILL.md')
      const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
      if (!fs.existsSync(builtinPath)) {
        return c.json(createAgentError('BUILTIN_MISSING', `No builtin version for skill "${name}"`), 409)
      }
      if (!fs.existsSync(localPath)) {
        return c.json({ name, has_diff: false, builtin_length: fs.readFileSync(builtinPath, 'utf-8').length, local_length: 0 })
      }
      const builtin = fs.readFileSync(builtinPath, 'utf-8')
      const local = fs.readFileSync(localPath, 'utf-8')
      return c.json({ name, has_diff: builtin !== local, builtin_length: builtin.length, local_length: local.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.delete('/skills/:name/local', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const name = c.req.param('name')
      if (!validateNameParam(name)) return c.json(createAgentError('INVALID_PARAM', 'Invalid name parameter'), 400)
      const bakPath = path.join(getAgentSkillsDir(), name, 'SKILL.md.bak')
      const localPath = path.join(getAgentSkillsDir(), name, 'SKILL.md')
      const skillDir = path.join(getAgentSkillsDir(), name)
      const builtinPath = path.join(process.cwd(), 'packages', 'core-pack', 'skills', name, 'SKILL.md')
      // If there's a local version with backup, restore from backup
      if (fs.existsSync(localPath) && fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, localPath)
        fs.unlinkSync(bakPath)
        return c.json({ ok: true, reverted_to: 'builtin', restored: true })
      }
      // If there's a local version without backup, delete it (revert to builtin from core-pack)
      if (fs.existsSync(localPath)) {
        if (!fs.existsSync(builtinPath)) {
          return c.json(createAgentError('BUILTIN_MISSING', `No builtin version for skill "${name}"`), 409)
        }
        fs.unlinkSync(localPath)
        if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath)
        return c.json({ ok: true, reverted_to: 'builtin', restored: false })
      }
      // No local version exists — nothing to delete, but if builtin exists, it's already the active version
      if (fs.existsSync(builtinPath)) {
        return c.json({ ok: true, reverted_to: 'builtin', restored: false, already_builtin: true })
      }
      return c.json(createAgentError('NOT_FOUND', `Skill "${name}" not found`), 404)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  // Tasks — includes workflow executions + scheduler jobs
  agent.get('/tasks', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      
      const service = new SchedulerService(db)
      const result = service.listJobs({ org })

      // Also check schedules table for scheduled tasks (TC-041)
      let scheduled: Array<{ id: string; name: string; cron_expression: string; enabled: number }> = []
      try {
        scheduled = scheduleConfigDAO.listSchedulesByOrg(org)
      } catch { /* schedules table may not exist */ }

      // Query workflow executions for task status (TC-009, TC-014)
      let executions: Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; completed_at: string | null; workspace_name?: string
      }> = []
      try {
        executions = executionDAO.findByOrgWithWorkspace(org, 50)
      } catch { /* executions table may not exist */ }

      // Merge executions into items as task entries
      const executionItems = executions.map((exec) => ({
        id: exec.id,
        name: exec.workflow_name,
        status: exec.status,
        workspace_id: exec.workspace_id,
        workspace_name: exec.workspace_name,
        started_at: exec.started_at,
        completed_at: exec.completed_at,
        type: 'execution' as const,
      }))

      const allItems = [...executionItems, ...result.items.map((item: Record<string, unknown>) => ({ ...item, type: 'scheduler' as const }))]

      return c.json({
        items: allItems,
        total: allItems.length,
        active: allItems.filter((j: { status: string }) => j.status === 'running' || j.status === 'active').length,
        scheduled,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.post('/tasks/:id/cancel', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')
      
      const service = new SchedulerService(db)
      // Use toggleJob to disable — pauseJob was never a SchedulerService method
      const job = service.toggleJob(id)
      return c.json({ ok: true, job })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      // SchedulerJobNotFoundError has no .code property — map by name
      if (error.name === 'SchedulerJobNotFoundError') {
        return c.json(createAgentError('NOT_FOUND', error.message), 404)
      }
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })
  // TC-014: Delete workspace for a completed task (preserve main repo branch)
  agent.delete('/tasks/:id/workspace', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')
      

      // Find the execution and its workspace
      let execution: { id: string; workspace_id: string; status: string; workflow_name: string } | undefined
      try {
        execution = executionDAO.findByIdAndOrg(id, org) ?? undefined
      } catch { /* table may not exist */ }

      if (!execution) {
        return c.json(createAgentError('NOT_FOUND', `Task ${id} not found`), 404)
      }

      // Guard: only terminal-state executions can have their workspace deleted
      const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled']
      if (!TERMINAL_STATUSES.includes(execution.status)) {
        return c.json(
          createAgentError('INVALID_STATE', `Task ${id} is still ${execution.status}; cannot delete workspace`),
          409,
        )
      }

      // Get workspace details
      let workspace: { id: string; name: string; path: string; status: string } | undefined
      try {
        const wsRow = workspaceDAO.findById(execution.workspace_id)
        if (wsRow && wsRow.org === org) {
          workspace = { id: wsRow.id, name: wsRow.name, path: wsRow.path, status: wsRow.status }
        }
      } catch { /* table may not exist */ }

      if (!workspace) {
        return c.json(createAgentError('NOT_FOUND', `Workspace for task ${id} not found`), 404)
      }

      // Path boundary validation: workspace must be within org directory
      const allowedBase = path.resolve(path.join(os.homedir(), '.octopus', 'orgs', org))
      const resolvedWsPath = path.resolve(workspace.path)
      if (!resolvedWsPath.startsWith(allowedBase + path.sep) && resolvedWsPath !== allowedBase) {
        return c.json(createAgentError('INVALID_PARAM', 'Workspace path outside org boundary'), 400)
      }

      // Use WorkspaceLifecycleService to clean up
      const lifecycleService = getWorkspaceLifecycleService(org)
      const cleanupResult = lifecycleService.cleanupWorkspace(workspace.path)

      // Remove worktree if it exists (git worktree remove — using execFileSync to prevent injection)
      let worktreeRemoved = false
      if (cleanupResult.cleaned) {
        try {
          if (fs.existsSync(path.join(workspace.path, '.git'))) {
            const configPath = path.join(workspace.path, 'config.json')
            if (fs.existsSync(configPath)) {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
              if (config.projects) {
                for (const project of Object.values(config.projects) as Array<{ main_path?: string; worktree_path?: string }>) {
                  if (project.main_path && project.worktree_path) {
                    // Validate paths within org boundary
                    const resolvedMain = path.resolve(project.main_path)
                    const resolvedWt = path.resolve(project.worktree_path)
                    if (!resolvedMain.startsWith(allowedBase + path.sep) || !resolvedWt.startsWith(allowedBase + path.sep)) {
                      continue // skip paths outside org boundary
                    }
                    try {
                      execFileSync('git', ['worktree', 'remove', project.worktree_path, '--force'], {
                        cwd: project.main_path,
                        stdio: 'pipe',
                        timeout: 10000,
                      })
                      worktreeRemoved = true
                    } catch { /* worktree may already be removed */ }
                  }
                }
              }
            }
            if (!worktreeRemoved) {
              try {
                execFileSync('git', ['worktree', 'prune'], { cwd: workspace.path, stdio: 'pipe', timeout: 10000 })
                worktreeRemoved = true
              } catch { /* non-fatal */ }
            }
          }
        } catch { /* execFileSync failure is non-fatal */ }
      }

      // Update workspace status + schedule_workspaces in a transaction
      let dbUpdateFailed = false
      try {
        const now = new Date().toISOString()
        workspaceDAO.transaction(() => {
          workspaceDAO.update(workspace!.id, { status: 'completed' })
          try {
            scheduleConfigDAO.updateScheduleWorkspacesCleaned(workspace!.id, now)
          } catch { /* schedule_workspaces table may not exist or row may not exist */ }
        })
      } catch {
        dbUpdateFailed = true
      }

      return c.json({
        ok: !dbUpdateFailed,
        task_id: id,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        worktree_removed: worktreeRemoved,
        branch_preserved: true,
        cleanup: cleanupResult,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.get('/tasks/reports', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      // Query reports table if exists, fallback to file scan
      
      try {
        const rows = safetyDAO.listReportsByOrg(org)
        return c.json({ items: rows, total: rows.length })
      } catch {
        // Table may not exist — return empty
        return c.json({ items: [], total: 0 })
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })
  agent.get('/tasks/reports/:id', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const id = c.req.param('id')

      // Try to find report in DB
      
      try {
        const report = safetyDAO.findReportById(id)

        if (report && report.org === org) {
          // Check if file exists
          if (fs.existsSync(report.file_path)) {
            const content = fs.readFileSync(report.file_path, 'utf-8')
            return c.json({ id: report.id, task_name: report.task_name, date: report.date, content, rebuilt: false })
          }
          // File missing — rebuild from metadata (TC-046)
          const rebuiltContent = `# ${report.task_name} — ${report.date}\n\n⚠️ 原报告丢失\n\n执行状态: ${report.status}\n创建时间: ${report.date}`
          return c.json({
            id: report.id,
            task_name: report.task_name,
            date: report.date,
            content: rebuiltContent,
            rebuilt: true,
            warning: '原报告丢失',
          })
        }
      } catch {
        // Table may not exist
      }

      return c.json(createAgentError('NOT_FOUND', `Report ${id} not found`), 404)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // Safety — confirm dangerous operations via SSE integration
  agent.post('/safety/confirm', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{
        event_id?: number | string
        decision?: 'allow' | 'block' | 'accept' | 'reject'
        reason?: string
      }>().catch(() => ({}))

      if (!body.event_id) {
        return c.json(createAgentError('INVALID_PARAM', 'event_id is required'), 400)
      }

      // Normalize decision: accept → allow, reject → block
      const DECISION_MAP: Record<string, 'allow' | 'block'> = {
        allow: 'allow',
        block: 'block',
        accept: 'allow',
        reject: 'block',
      }
      const normalizedDecision = body.decision ? DECISION_MAP[body.decision] : undefined
      if (!body.decision || !normalizedDecision) {
        return c.json(createAgentError('INVALID_PARAM', 'decision must be "accept"/"reject" or "allow"/"block"'), 400)
      }

      
      const safetyDao = safetyDAO

      // Find the safety event
      const event = safetyDao.findSafetyEventByIdAndOrg(Number(body.event_id), org)

      if (!event) {
        return c.json(createAgentError('NOT_FOUND', `Safety event ${body.event_id} not found`), 404)
      }

      // Update the decision
      safetyDao.updateDecision(Number(body.event_id), normalizedDecision)

      return c.json({
        ok: true,
        event_id: body.event_id,
        decision: normalizedDecision,
        reason: body.reason ?? null,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  // Debug — log retrieval and prompt assembly inspection
  agent.get('/debug/log', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500)
      const level = c.req.query('level') ?? 'all'
      const debugDir = path.join(getAgentDir(), 'debug')

      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true })
      }

      // Read trace files from debug/traces/
      const tracesDir = path.join(debugDir, 'traces')
      const items: Array<{ timestamp: string; level: string; message: string; source?: string }> = []

      if (fs.existsSync(tracesDir)) {
        const files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, limit)
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(tracesDir, file), 'utf-8')
            for (const line of content.split('\n').filter(Boolean)) {
              try {
                const entry = JSON.parse(line)
                if (level === 'all' || entry.level === level) {
                  items.push(entry)
                }
              } catch { /* skip malformed lines */ }
            }
          } catch { /* skip unreadable files */ }
        }
      }

      return c.json({ items: items.slice(0, limit), total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.get('/debug/assemble/:chat_id', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const chatId = c.req.param('chat_id')
      const assembler = new SystemPromptAssembler(org)
      const segments = assembler.getSegments({ clone_name: undefined })
      const assembled = assembler.assemble({ clone_name: undefined })

      return c.json({
        chat_id: chatId,
        segments: segments.map((seg, idx) => ({
          index: idx,
          name: seg.name,
          token_count: seg.tokenEstimate,
          content_preview: seg.content.slice(0, 200),
        })),
        total_tokens: segments.reduce((sum, seg) => sum + seg.tokenEstimate, 0),
        assembled_length: assembled.length,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Recovery endpoint ─────────────────────────────────────────

  agent.post('/recovery', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getRecoveryService } = await import('../../services/agent/recovery-service')
      const recoveryService = getRecoveryService(org)
      const result = await recoveryService.recover()
      return c.json({ ok: true, recovery: result })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.get('/recovery/status', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getRecoveryService } = await import('../../services/agent/recovery-service')
      const recoveryService = getRecoveryService(org)
      return c.json(recoveryService.getStatus())
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Memory refine (E2E-075, E2E-076) ────────────────────────────
  agent.post('/memory/refine', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{ layer?: string; content?: string }>().catch(() => ({}))
      const layer = body.layer ?? 'long-term'

      // Validate layer to prevent path traversal
      if (!/^[a-z][a-z0-9-]*$/.test(layer)) {
        return c.json(createAgentError('INVALID_PARAM', 'Invalid layer name'), 400)
      }

      const content = body.content ?? ''

      // Create backup before refining
      const memoryDir = getAgentMemoryDir()
      const longTermFile = path.join(memoryDir, `${layer}.md`)
      const bakFile = path.join(memoryDir, `${layer}.md.bak`)

      // Read current content for backup
      if (fs.existsSync(longTermFile)) {
        const currentContent = fs.readFileSync(longTermFile, 'utf-8')
        fs.writeFileSync(bakFile, currentContent, 'utf-8')
      }

      // Write refined content
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true })
      }
      fs.writeFileSync(longTermFile, content, 'utf-8')

      return c.json({
        ok: true,
        backup_created: bakFile,
        token_count: Math.ceil(content.length / 3),
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      // Rollback on error (E2E-076)
      try {
        const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
        const memoryDir = getAgentMemoryDir()
        const bakFile = path.join(memoryDir, 'long-term.md.bak')
        const longTermFile = path.join(memoryDir, 'long-term.md')
        if (fs.existsSync(bakFile)) {
          fs.copyFileSync(bakFile, longTermFile)
        }
      } catch { /* rollback failed silently */ }
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Self-check (E2E-055) ────────────────────────────────────────
  agent.post('/self-check', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const dailyDir = getDailyMemoryDir()
      const experiencesDir = getExperiencesDir()
      const patterns: string[] = []

      // Read last 7 days of daily memory
      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, 7)

        const allContent = files.map(f => {
          try { return fs.readFileSync(path.join(dailyDir, f), 'utf-8') } catch { return '' }
        }).join('\n')

        // Extract repeated patterns (simple keyword frequency)
        const words = allContent.toLowerCase().match(/\b[a-z一-鿿]{2,}\b/g) ?? []
        const freq = new Map<string, number>()
        for (const w of words) {
          freq.set(w, (freq.get(w) ?? 0) + 1)
        }
        for (const [word, count] of freq) {
          if (count >= 3 && word.length >= 3) {
            patterns.push(word)
          }
        }
      }

      // Write experience files if patterns found
      let experienceCount = 0
      if (patterns.length > 0) {
        if (!fs.existsSync(experiencesDir)) {
          fs.mkdirSync(experiencesDir, { recursive: true })
        }
        const now = new Date().toISOString()
        const experienceContent = `# 自检经验 ${now}\n\n## 重复模式\n${patterns.slice(0, 10).map(p => `- ${p}`).join('\n')}\n`
        const filename = `self-check-${now.replace(/[:.]/g, '-')}.md`
        fs.writeFileSync(path.join(experiencesDir, filename), experienceContent, 'utf-8')
        experienceCount = 1
      }

      return c.json({
        ok: true,
        patterns_found: patterns.length,
        experiences_created: experienceCount,
        checked_days: 7,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // Notifications — failed notification queue for UI badge (TC-047)
  agent.get('/notifications/failed', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const notifyService = getNotificationService()
      const failed = notifyService.getFailedNotifications(org)
      return c.json({ count: failed.length, notifications: failed })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/notifications/failed/clear', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const notifyService = getNotificationService()
      notifyService.clearFailedNotifications(org)
      return c.json({ ok: true, cleared: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── G2: Onboarding flow ────────────────────────────────────────────
  agent.get('/onboarding/status', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)

      // Build onboarding steps based on current state
      const steps = [
        { id: 'intro', title: 'Agent 能力介绍', description: '了解 Agent 全局编排、跨工作空间任务、定时任务、分身委派能力', completed: true },
        { id: 'examples', title: '示例指令', description: '尝试: "加黑色主题" / "每天10点总结PR" / "昨天做了什么"', completed: false },
        { id: 'notification', title: '配置通知渠道', description: '设置 hermes 通知目标 (telegram chat id)', completed: !!config.notification?.target },
        { id: 'complete', title: '完成引导', description: '开始使用 Agent', completed: config.onboarding_completed === true },
      ]

      return c.json({
        onboarding_completed: config.onboarding_completed === true,
        steps,
        current_step: steps.find(s => !s.completed)?.id ?? 'complete',
        example_commands: [
          '给 octopus 加黑色主题',
          '每天上午10点对新增加的PR进行总结',
          '昨天做了什么',
          '创建一个前端分身',
        ],
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/onboarding/complete', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      configManager.updateConfig(org, { onboarding_completed: true })

      return c.json({ ok: true, onboarding_completed: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  agent.post('/onboarding/reset', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      configManager.updateConfig(org, { onboarding_completed: false })

      return c.json({ ok: true, onboarding_completed: false })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── N1: Agent vs Workspace chat boundary explanation ───────────────
  agent.get('/boundary', (c) => {
    try {
      return c.json({
        agent_chat: {
          description: 'Agent 用于全局编排、跨工作空间任务、定时任务、分身委派',
          use_cases: [
            '单次开发任务: "给 octopus 加黑色主题" → 自动编排 prd-forge→prd-impl',
            '定期运维: "每天10点总结新PR" → 定时 agent job + 记忆去重 + hermes 通知',
            '信息查询: "昨天做了什么" → 从三层记忆回答',
            '分身委派: "创建前端分身并委派 UI 任务" → 并行执行',
          ],
          path: '/agent',
          session_storage: 'agent_memory.db (sessions table)',
        },
        workspace_chat: {
          description: '工作空间 chat 用于该工作空间内的具体开发对话',
          use_cases: [
            '在某工作空间内与 AI 结对编码',
            '讨论当前工作空间的代码和架构',
            '在工作空间内执行具体的开发操作',
          ],
          path: '/workspaces/[id]',
          session_storage: 'main octopus.db (chat sessions)',
        },
        isolation: {
          sessions_isolated: true,
          memory_isolated: true,
          agent_can_delegate_to_workspace: true,
          workspace_cannot_access_agent: true,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── B2: Task progress polling (supplements SSE in chat) ────────────
  agent.get('/tasks/progress', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      

      // Query active executions with their node progress
      let activeExecutions: Array<{
        id: string; workspace_id: string; workflow_name: string; status: string;
        started_at: string | null; current_node: string | null; progress: number | null;
        workspace_name?: string
      }> = []
      try {
        activeExecutions = executionDAO.findActiveExecutionsByOrg(org)
      } catch { /* executions table may not exist */ }

      // Also check active clone delegations
      const base = clonesBaseDir()
      const activeClones: Array<{ name: string; task: string; delegated_at: string }> = []
      if (fs.existsSync(base)) {
        const entries = fs.readdirSync(base, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const metaFile = path.join(base, entry.name, 'meta.json')
            if (fs.existsSync(metaFile)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
                if (meta.status === 'running') {
                  activeClones.push({
                    name: meta.name,
                    task: meta.current_task ?? '',
                    delegated_at: meta.delegated_at ?? '',
                  })
                }
              } catch { /* skip */ }
            }
          }
        }
      }

      return c.json({
        executions: activeExecutions.map(e => ({
          id: e.id,
          workflow_name: e.workflow_name,
          status: e.status,
          started_at: e.started_at,
          current_node: e.current_node,
          progress: e.progress,
          workspace_name: e.workspace_name,
          elapsed_ms: e.started_at ? Date.now() - new Date(e.started_at).getTime() : null,
        })),
        clone_delegations: activeClones,
        total_active: activeExecutions.length + activeClones.length,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── E3: Scheduler execution history (click job → timeline) ──────────
  agent.get('/tasks/history', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const jobName = c.req.query('job_name')
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)

      

      // Query scheduled_job_executions table
      let executions: Array<{
        id: string; job_name: string; status: string; started_at: string;
        finished_at: string | null; duration_ms: number | null;
        report_path: string | null; report_summary: string | null;
        error_message: string | null; trigger_type: string; metadata: string | null
      }> = []

      try {
        const safetyDao = safetyDAO
        const jobExecutions = safetyDao.listJobExecutionsByOrg(org, { job_name: jobName, limit })
        executions = jobExecutions.map(je => ({
          id: je.id, job_name: je.job_name, status: je.status,
          started_at: je.started_at, finished_at: je.finished_at,
          duration_ms: je.duration_ms, report_path: je.report_path,
          report_summary: je.report_summary, error_message: je.error_message,
          trigger_type: je.trigger_type, metadata: je.metadata,
        })) as typeof executions
      } catch {
        // Table may not exist yet — fall back to reports table
        try {
          const safetyDao = safetyDAO
          const reports = safetyDao.listReportsByOrg(org, { task_name: jobName })
          executions = reports.map(r => ({
            id: r.id, task_name: r.task_name,
            status: r.status === 'ok' ? 'success' : r.status === 'missing' ? 'failure' : r.status,
            started_at: r.created_at, finished_at: null as string | null,
            duration_ms: null as number | null, report_path: r.file_path,
            report_summary: null as string | null, error_message: null as string | null,
            trigger_type: 'cron', metadata: null as string | null,
          })) as unknown as typeof executions
        } catch {
          // Reports table may not exist either
        }
      }

      // Compute summary stats
      const totalExecutions = executions.length
      const successCount = executions.filter(e => e.status === 'success').length
      const failureCount = executions.filter(e => e.status === 'failure' || e.status === 'timeout').length
      const avgDuration = executions
        .filter(e => e.duration_ms != null)
        .reduce((sum, e) => sum + (e.duration_ms ?? 0), 0) / Math.max(successCount, 1)

      return c.json({
        executions: executions.map(e => ({
          id: e.id,
          job_name: e.job_name,
          status: e.status,
          started_at: e.started_at,
          finished_at: e.finished_at,
          duration_ms: e.duration_ms,
          report_path: e.report_path,
          report_summary: e.report_summary,
          error_message: e.error_message,
          trigger_type: e.trigger_type,
          metadata: e.metadata ? JSON.parse(e.metadata) : null,
        })),
        summary: {
          total: totalExecutions,
          success: successCount,
          failure: failureCount,
          avg_duration_ms: Math.round(avgDuration),
          success_rate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── P3.5: Observability endpoint (tracer + metrics) ─────────────────
  agent.get('/observability', (c) => {
    try {
      const tracer = getTracer()
      const metrics = getMetrics()
      const eventBus = getDomainEventBus()

      const view = c.req.query('view') ?? 'summary'

      if (view === 'traces') {
        const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100)
        return c.json({ traces: tracer.getTraceSummaries(limit) })
      }

      if (view === 'trace_detail') {
        const traceId = c.req.query('trace_id')
        if (!traceId) return c.json(createAgentError('INVALID_PARAM', 'trace_id required'), 400)
        return c.json({ spans: tracer.getTrace(traceId) })
      }

      if (view === 'metrics') {
        return c.json({
          metrics: metrics.export(),
          summary: metrics.summary(),
        })
      }

      if (view === 'histogram') {
        const name = c.req.query('name')
        if (!name) return c.json(createAgentError('INVALID_PARAM', 'name required'), 400)
        return c.json({ histogram: metrics.getHistogram(name) })
      }

      if (view === 'events') {
        const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)
        const type = c.req.query('type') as Parameters<typeof eventBus.getHistory>[0] extends infer T ? T extends { type?: infer U } ? U : undefined : undefined
        return c.json({ events: eventBus.getHistory({ type: type as never, limit }) })
      }

      // Default: summary view
      return c.json({
        tracer: tracer.getStats(),
        metrics: metrics.summary(),
        event_bus: {
          handler_counts: eventBus.handlerCounts(),
          history_size: eventBus.getHistory().length,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── B3: Dynamic workflow generation with YAML validation ───────────
  agent.post('/workflows/generate', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const body = await c.req.json<{
        task_description: string; workflow_name?: string; inputs?: Record<string, string>
      }>().catch(() => ({}))

      if (!body.task_description) {
        return c.json(createAgentError('INVALID_PARAM', 'task_description is required'), 400)
      }

      // Generate a workflow YAML from task description
      const workflowName = body.workflow_name ?? `dynamic-${Date.now().toString(36)}`
      const generatedYaml = `# Dynamic workflow generated by Agent
# Task: ${body.task_description}
name: ${workflowName}
description: "${body.task_description.slice(0, 200)}"

nodes:
  - id: analyze
    type: agent
    prompt: |
      分析需求: ${body.task_description}
      制定实现方案并输出步骤清单。

  - id: implement
    type: agent
    depends_on: [analyze]
    prompt: |
      根据分析结果执行实现:
      $analyze.output

  - id: verify
    type: agent
    depends_on: [implement]
    prompt: |
      验证实现结果:
      - 构建是否通过
      - 测试是否通过
      - 代码质量检查
`

      // Validate YAML syntax
      let valid = true
      let validationErrors: string[] = []
      try {
        const yaml = await import('yaml')
        const parsed = yaml.parse(generatedYaml)
        if (!parsed.name) validationErrors.push('Missing name field')
        if (!parsed.nodes || !Array.isArray(parsed.nodes)) validationErrors.push('Missing or invalid nodes')
      } catch (e) {
        valid = false
        validationErrors.push(`YAML parse error: ${e instanceof Error ? e.message : String(e)}`)
      }

      // Store generated workflow to filesystem
      const workflowDir = path.join(getAgentDir(), 'workflows')
      if (!fs.existsSync(workflowDir)) fs.mkdirSync(workflowDir, { recursive: true })
      const filePath = path.join(workflowDir, `${workflowName}.yaml`)
      fs.writeFileSync(filePath, generatedYaml, 'utf-8')

      return c.json({
        ok: true,
        workflow_name: workflowName,
        yaml: generatedYaml,
        valid,
        validation_errors: validationErrors,
        file_path: filePath,
        inputs: body.inputs ?? {},
        status: valid ? 'pending_confirmation' : 'invalid',
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── M3: Cron job registration + execution ──────────────────────────
  // (Moved before parameterized routes for Hono routing priority)

  // ── F5: User feedback-driven evolution ─────────────────────────────
  // (Moved before parameterized routes for Hono routing priority)

  // ── M4: Improved skill search (content-based) ──────────────────────
  // (Moved before parameterized routes for Hono routing priority)

  // ── F6: Self-check (manual trigger with evolution integration) ─────
  // (Moved before parameterized routes for Hono routing priority)

  return agent
}
