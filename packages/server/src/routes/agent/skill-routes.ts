// packages/server/src/routes/agent/skill-routes.ts
//
// Agent skill routes — search, list, get by name, diff against builtin,
// and local version management (revert/delete).
//
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getAgentSkillsDir } from '../../services/agent/paths'
import { getSubsystemAdapter } from '../../services/agent/subsystem-adapter'

// ── Path traversal guard ─────────────────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/
const validateNameParam = (name: string): boolean => SAFE_NAME_RE.test(name) && name.length <= 200

export interface SkillRouteDeps {
  // No DAO deps needed — skill routes are filesystem-based
}

export function createSkillRoutes(_deps: SkillRouteDeps = {}): Hono {
  const app = new Hono()

  // M4: Improved skill search (must be before /skills/:name)
  app.get('/skills/search', (c) => {
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

  // ── Skills list ─────────────────────────────────────────────────
  app.get('/skills', (c) => {
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

  // ── Skills — get by name ─────────────────────────────────────────
  app.get('/skills/:name', (c) => {
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

  // ── Skills — diff against builtin ────────────────────────────────
  app.get('/skills/:name/diff-builtin', (c) => {
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

  // ── Skills — delete local version (revert to builtin) ────────────
  app.delete('/skills/:name/local', (c) => {
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

  return app
}
