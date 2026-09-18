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
import { getAgentService } from '../../services/agent/agent-service'
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

  // ── Debug — log retrieval ──────────────────────────────────────────
  app.get('/debug/log', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100)
      const sessionId = c.req.query('session_id') ?? undefined
      const cursor = c.req.query('cursor') ?? undefined
      const search = c.req.query('search') ?? undefined
      const startDate = c.req.query('start_date') ?? undefined
      const endDate = c.req.query('end_date') ?? undefined

      const agentService = getAgentService()
      const result = await agentService.getDebugLog(org, {
        limit, session_id: sessionId, cursor, search, start_date: startDate, end_date: endDate,
      })
      return c.json(result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  // ── Debug — prompt assembly inspection ─────────────────────────────
  app.get('/debug/assemble/:chat_id', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const chatId = c.req.param('chat_id')
      const agentService = getAgentService()
      const detail = await agentService.getAssembleDetail(org, chatId)
      return c.json(detail)
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

  // ── Notification test ──────────────────────────────────────────
  app.post('/config/test-notification', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)

      const { getConfigManager } = await import('../../services/agent/config-manager')
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)

      const platform = config.notification?.platform
      const target = config.notification?.target

      if (!platform || platform === 'none') {
        return c.json({ ok: false, detail: '通知未配置或已禁用 (platform=none)' })
      }

      if (!target) {
        return c.json({ ok: false, detail: '通知目标未配置' })
      }

      const body = await c.req.json<{ message?: string }>().catch(() => ({}))
      const message = body.message ?? '通知测试成功'

      const notifyService = getNotificationService()
      const result = await notifyService.sendNotification(org, {
        type: 'general',
        title: 'Octopus 通知测试',
        body: message,
        priority: 'normal',
      })

      return c.json({
        ok: result.sent,
        detail: result.sent
          ? `通知已发送至 ${result.platform}:${result.target}`
          : `通知发送失败: ${result.error ?? '未知错误'}`,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      return c.json(createAgentError('INTERNAL_ERROR', error.message), 500)
    }
  })

  return app
}
