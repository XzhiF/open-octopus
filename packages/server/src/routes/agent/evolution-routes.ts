// packages/server/src/routes/agent/evolution-routes.ts
//
// Agent evolution routes — feedback-driven skill improvement, self-check evolution,
// changelog/experience listing, rollback, and experience recording.
//
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { createAgentError } from './middleware'
import { getEvolutionService } from '../../services/agent/evolution-service'
import { getAgentSkillsDir } from '../../services/agent/paths'
import type { EvolutionDAO } from '../../db/dao'

export interface EvolutionRouteDeps {
  evolutionDAO: EvolutionDAO
}

export function createEvolutionRoutes(deps: EvolutionRouteDeps): Hono {
  const { evolutionDAO } = deps
  const app = new Hono()

  // F5: User feedback-driven evolution
  app.post('/evolution/feedback', async (c) => {
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

  // F6: Self-check with evolution integration
  app.post('/self-check/evolve', async (c) => {
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

  // Evolution changelog
  app.get('/evolution/changelog', (c) => {
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

  // Evolution experiences list
  app.get('/evolution/experiences', (c) => {
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

  // Evolution rollback
  app.post('/evolution/rollback/:id', (c) => {
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

  // Record evolution entry
  app.post('/evolution/record', async (c) => {
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

  // Record experience entry
  app.post('/evolution/experience', async (c) => {
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

  return app
}
