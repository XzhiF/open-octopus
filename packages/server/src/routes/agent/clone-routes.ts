// packages/server/src/routes/agent/clone-routes.ts
//
// Agent clone lifecycle routes — legacy operations retained after API unification.
// CRUD (create/list/delete) moved to /api/clones (filesystem-backed).
// This module retains: merge, delegate cancel, experiences, activate, deactivate.
//
import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getAgentDir, getClonesDir } from '../../services/agent/paths'

export interface CloneRouteDeps {
  // No external deps needed for remaining routes
}

// ── Path traversal guard ─────────────────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/
const validateNameParam = (name: string): boolean => SAFE_NAME_RE.test(name) && name.length <= 200

// ── Filesystem base directory for clone storage ──────────────────
const clonesBaseDir = () => getClonesDir()

export function createCloneRoutes(deps: CloneRouteDeps): Hono {
  const app = new Hono()

  // ── Clone merge (archive memory + cleanup) ────────────────────────
  app.post('/clones/:name/merge', async (c) => {
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

  // ── Clone delegate cancel ─────────────────────────────────────────
  app.post('/clones/:name/delegate/cancel', (c) => {
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

  // ── Clone experiences (stub) ──────────────────────────────────────
  app.get('/clones/:name/experiences', (c) => {
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

  // ── Clone activate (TC-038: clone use) ────────────────────────────
  app.post('/clones/:name/activate', async (c) => {
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
  app.delete('/clones/active', async (c) => {
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

  return app
}
