import { Hono } from 'hono'
import { getConfigManager } from '../../services/agent/config-manager'
import { AgentSessionDAO } from '../../db/dao'
import { createAgentError, mapErrorToStatus } from './middleware'

export function createSafeModeRoutes(sessionDAO: AgentSessionDAO): Hono {
  const safeMode = new Hono()

  /**
   * GET /safe-mode — Check safe mode status
   */
  safeMode.get('/safe-mode', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const manager = getConfigManager()
      const config = manager.getConfig(org)

      // Auto-enable safe mode if inactive beyond threshold (TC-066)
      let enabled = config.safe_mode.enabled
      let reason: string | null = enabled ? 'manual' : null

      if (!enabled) {
        try {
          const threshold = config.safe_mode.inactive_days_threshold ?? 14
          const lastSession = sessionDAO.findLatestMessageTimestamp()

          if (lastSession?.last_at) {
            const lastActive = new Date(lastSession.last_at).getTime()
            const daysSince = (Date.now() - lastActive) / (1000 * 60 * 60 * 24)
            if (daysSince >= threshold) {
              enabled = true
              reason = 'inactivity'
              // Persist to config
              manager.updateConfig(org, {
                safe_mode: { enabled: true, inactive_days_threshold: threshold },
              })
            }
          }
        } catch {
          // DB query failure is non-fatal — proceed with config value
        }
      }

      return c.json({
        enabled,
        reason,
        inactive_days_threshold: config.safe_mode.inactive_days_threshold,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /safe-mode/enable — Enable safe mode
   */
  safeMode.post('/safe-mode/enable', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const manager = getConfigManager()
      const result = manager.updateConfig(org, {
        safe_mode: { enabled: true, inactive_days_threshold: manager.getConfig(org).safe_mode.inactive_days_threshold },
      })

      // ── Notify hermes about safe mode activation (PRD H2) ─────
      try {
        const { getNotificationService } = await import('../../services/agent/notification-service')
        await getNotificationService().sendNotification(org, {
          type: 'safe_mode',
          title: 'Agent 已进入安全降级模式',
          body: 'SKILL 自动进化已暂停，定时任务熔断保护已启用，写操作需要确认。',
          priority: 'high',
        })
      } catch {
        // Notification failure is non-fatal
      }

      return c.json({
        ok: true,
        safe_mode: {
          enabled: result.config.safe_mode.enabled,
          reason: 'manual',
          evolution_paused: true,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /safe-mode/disable — Disable safe mode
   */
  safeMode.post('/safe-mode/disable', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const manager = getConfigManager()
      const result = manager.updateConfig(org, {
        safe_mode: { enabled: false, inactive_days_threshold: manager.getConfig(org).safe_mode.inactive_days_threshold },
      })
      return c.json({
        ok: true,
        safe_mode: {
          enabled: result.config.safe_mode.enabled,
          reason: null,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return safeMode
}
