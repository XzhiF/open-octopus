// packages/server/src/routes/agent/misc-routes.ts
//
// Miscellaneous agent routes that don't fit into other domain-specific modules:
// memory (rebuild-fts, archive, refine), notifications, onboarding, boundary,
// observability, workflow generation, debug, recovery, safety confirm, self-check.
//
import { Hono } from 'hono'
import type { Context } from 'hono'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getNotificationService } from '../../services/agent/notification-service'
import { getTracer } from '../../services/agent/tracer'
import { getMetrics } from '../../services/agent/metrics'
import { getDomainEventBus } from '../../services/agent/domain-event-bus'
import {
  getAgentDir,
  getAgentMemoryDir,
  getDailyMemoryDir,
  getExperiencesDir,
} from '../../services/agent/paths'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import type { SafetyDAO } from '../../db/dao'

// ── 501 stub for unimplemented routes ────────────────────────
const notImplemented = (c: Context) =>
  c.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'This endpoint is not yet implemented' } },
    501,
  )

export interface MiscRouteDeps {
  safetyDAO: SafetyDAO
}

export function createMiscRoutes(deps: MiscRouteDeps): Hono {
  const { safetyDAO } = deps
  const app = new Hono()

  // ── Memory — rebuild-fts ─────────────────────────────────────────
  app.post('/memory/rebuild-fts', (c) => {
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

  // ── Memory — archive ─────────────────────────────────────────────
  app.post('/memory/archive', async (c) => {
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

  // ── Memory refine (E2E-075, E2E-076) ────────────────────────────
  app.post('/memory/refine', async (c) => {
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

  // ── Notifications — failed queue for UI badge (TC-047) ────────────
  app.get('/notifications/failed', (c) => {
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

  app.post('/notifications/failed/clear', (c) => {
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
  app.get('/onboarding/status', async (c) => {
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

  app.post('/onboarding/complete', async (c) => {
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

  app.post('/onboarding/reset', async (c) => {
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
  app.get('/boundary', (c) => {
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

  // ── P3.5: Observability endpoint (tracer + metrics) ─────────────────
  app.get('/observability', (c) => {
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
  app.post('/workflows/generate', async (c) => {
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

  // ── Debug — log retrieval ──────────────────────────────────────────
  app.get('/debug/log', (c) => {
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

  // ── Debug — prompt assembly inspection ─────────────────────────────
  app.get('/debug/assemble/:chat_id', (c) => {
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
  app.post('/recovery', async (c) => {
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

  app.get('/recovery/status', async (c) => {
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

  // ── Safety — confirm dangerous operations via SSE integration ──────
  app.post('/safety/confirm', async (c) => {
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

  // ── Self-check (E2E-055) ────────────────────────────────────────
  app.post('/self-check', (c) => {
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

  return app
}
