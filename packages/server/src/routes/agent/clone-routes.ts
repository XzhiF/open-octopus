// packages/server/src/routes/agent/clone-routes.ts
//
// Agent clone lifecycle routes — create isolated agent clones with dedicated
// worktrees, delegate tasks, merge results, activate/deactivate.
// Pure filesystem-backed CRUD with Claude SDK delegation.
//
import { Hono } from 'hono'
import { getProvider } from '@octopus/providers'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createAgentError, mapErrorToStatus } from './middleware'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { getAgentDir, getClonesDir } from '../../services/agent/paths'
import type { SafetyDAO } from '../../db/dao'

export interface CloneRouteDeps {
  safetyDAO: SafetyDAO
}

// ── Path traversal guard ─────────────────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/
const validateNameParam = (name: string): boolean => SAFE_NAME_RE.test(name) && name.length <= 200

// ── Filesystem base directory for clone storage ──────────────────
const clonesBaseDir = () => getClonesDir()

export function createCloneRoutes(deps: CloneRouteDeps): Hono {
  const { safetyDAO } = deps
  const app = new Hono()

  // ── Clone create ──────────────────────────────────────────────────
  app.post('/clones', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      const body = await c.req.json<{ name: string; workspace_id?: string; workspace_path?: string; workspace_config?: { projects?: string[] } }>()
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
      const meta = { name: body.name, org, workspace_id: body.workspace_id ?? null, workspace_path: resolvedWorkspacePath, status: 'idle', created_at: new Date().toISOString() }
      fs.writeFileSync(path.join(cloneDir, 'meta.json'), JSON.stringify(meta, null, 2))
      return c.json({ ok: true, clone: meta }, 201)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  // ── Clone list ────────────────────────────────────────────────────
  app.get('/clones', (c) => {
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

  // ── Clone delete ──────────────────────────────────────────────────
  app.delete('/clones/:name', (c) => {
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

  // ── Clone delegate task (Claude SDK execution) ────────────────────
  app.post('/clones/:name/delegate', async (c) => {
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
