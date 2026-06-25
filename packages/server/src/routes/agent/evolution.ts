import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getEvolutionService } from '../../services/agent/evolution-service'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getAgentSkillsDir } from '../../services/agent/paths'

export function createEvolutionRoutes(): Hono {
  const evolution = new Hono()

  /**
   * GET /evolution/changelog — List evolution log entries
   */
  evolution.get('/evolution/changelog', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const skill_name = c.req.query('skill')
      const limit = parseInt(c.req.query('limit') ?? '50', 10)

      const items = getEvolutionService().listChangelog(org, { skill_name, limit })
      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /evolution/experiences — List experiences
   */
  evolution.get('/evolution/experiences', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const skill = c.req.query('skill')
      const items = getEvolutionService().listExperiences(org, skill)
      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /evolution/rollback/:id — Rollback an evolution entry
   */
  evolution.post('/evolution/rollback/:id', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const id = parseInt(c.req.param('id'), 10)
      if (isNaN(id)) {
        return c.json(createAgentError('INVALID_PARAM', 'Invalid rollback ID'), 400)
      }

      const success = getEvolutionService().rollback(org, id)
      if (!success) {
        return c.json(createAgentError('NOT_FOUND', `Evolution entry #${id} not found`), 404)
      }

      return c.json({ ok: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /skills — List installed skills
   */
  evolution.get('/skills', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

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

      // Also check core-pack built-in skills
      const corePackDir = path.join(process.cwd(), 'packages', 'core-pack', 'skills')
      if (fs.existsSync(corePackDir)) {
        const entries = fs.readdirSync(corePackDir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory() && !items.find((i) => i.name === entry.name)) {
            const skillFile = path.join(corePackDir, entry.name, 'SKILL.md')
            if (fs.existsSync(skillFile)) {
              items.push({
                name: entry.name,
                source: 'builtin',
                has_backup: false,
              })
            }
          }
        }
      }

      return c.json({ items, total: items.length })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return evolution
}
