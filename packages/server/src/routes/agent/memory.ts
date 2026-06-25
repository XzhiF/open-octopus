import { Hono } from 'hono'
import { getMemoryService, type MemoryLayer } from '../../services/agent/memory-service'
import { getConfigManager } from '../../services/agent/config-manager'
import { createAgentError, mapErrorToStatus } from './middleware'
import { getAgentDir, getDailyMemoryDir, getLongTermMemoryPath } from '../../services/agent/paths'

const VALID_LAYERS: MemoryLayer[] = ['long-term', 'daily', 'session']

export function createMemoryRoutes(): Hono {
  const memory = new Hono()

  /**
   * GET /memory/search — Search across memory files
   */
  memory.get('/memory/search', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const query = c.req.query('q')
      if (!query) {
        return c.json(createAgentError('INVALID_PARAM', 'Query parameter "q" is required'), 400)
      }

      // FTS5 search with LIKE fallback (PRD C3 §FTS降级)
      let results: unknown[]
      let degraded = false
      try {
        results = getMemoryService().searchMemory(org, query, parseInt(c.req.query('top_k') ?? '3', 10))
      } catch {
        // FTS index may be corrupted — auto-trigger rebuild and retry with LIKE
        degraded = true
        try {
          getMemoryService().rebuildFtsIndex(org)
          results = getMemoryService().searchMemory(org, query, parseInt(c.req.query('top_k') ?? '3', 10))
        } catch {
          results = []
        }
      }
      return c.json({ results, degraded })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /memory/:layer — Read memory for a specific layer
   */
  memory.get('/memory/:layer', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const layer = c.req.param('layer') as MemoryLayer
      if (!VALID_LAYERS.includes(layer)) {
        return c.json(
          createAgentError('INVALID_PARAM', `Invalid layer. Must be one of: ${VALID_LAYERS.join(', ')}`),
          400,
        )
      }

      const result = getMemoryService().readMemory(org, layer)
      return c.json(result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /memory — Write memory content
   */
  memory.post('/memory', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      // Safe mode blocks all memory writes
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)
      if (config.safe_mode.enabled) {
        return c.json(
          createAgentError('SAFE_MODE_READONLY', 'Safe mode is enabled. Memory writes are blocked.'),
          409,
        )
      }

      const body = await c.req.json<{ layer?: string; content?: string; expected_last_modified?: string }>()

      if (!body.layer || !VALID_LAYERS.includes(body.layer as MemoryLayer)) {
        return c.json(
          createAgentError('INVALID_PARAM', `"layer" must be one of: ${VALID_LAYERS.join(', ')}`),
          400,
        )
      }
      if (typeof body.content !== 'string') {
        return c.json(
          createAgentError('INVALID_PARAM', '"content" must be a string'),
          400,
        )
      }

      const layer = body.layer as MemoryLayer

      if (layer === 'daily') {
        const result = getMemoryService().appendDaily(org, body.content)
        return c.json({ ok: true, token_count: result.token_count })
      }

      try {
        const result = getMemoryService().writeMemory(org, layer, body.content, body.expected_last_modified)
        return c.json({ ok: true, token_count: result.token_count })
      } catch (writeErr: unknown) {
        const wErr = writeErr instanceof Error ? writeErr : new Error(String(writeErr))
        const errCode = (wErr as { code?: string }).code
        if (errCode === 'MEMORY_CONFLICT') {
          return c.json(
            createAgentError('MEMORY_CONFLICT', wErr.message, {
              server_content: (wErr as { serverContent?: string }).serverContent,
            }),
            409,
          )
        }
        throw writeErr
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /memory/rebuild-fts — Rebuild FTS indexes (PRD P2.2)
   */
  memory.post('/memory/rebuild-fts', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const result = getMemoryService().rebuildFtsIndex(org)
      return c.json({ ok: true, indexed_count: result.indexed_count })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /memory/archive — Manual archive trigger for daily memory (PRD C4)
   */
  memory.post('/memory/archive', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const body = await c.req.json<{ date?: string }>().catch(() => ({}))
      const fs = await import('fs')
      const path = await import('path')
      const os = await import('os')

      const agentDir = getAgentDir()
      const dailyDir = getDailyMemoryDir()
      const archiveDir = path.join(dailyDir, 'archive')
      const longTermPath = getLongTermMemoryPath()

      // Find the target daily file
      const targetDate = body.date ?? new Date(Date.now() - 86400000).toISOString().split('T')[0]
      const dailyFile = path.join(dailyDir, `${targetDate}.md`)

      if (!fs.existsSync(dailyFile)) {
        return c.json({ ok: true, archived: false, reason: 'No daily memory found for date' })
      }

      // Read daily content and extract highlights
      const content = fs.readFileSync(dailyFile, 'utf-8').trim()

      // Archive to long-term memory
      let mergeFailed = false
      try {
        const existingLt = fs.existsSync(longTermPath) ? fs.readFileSync(longTermPath, 'utf-8') : ''
        const merged = `${existingLt}\n\n## 归档摘要 (${targetDate})\n\n${content.slice(0, 1000)}`
        const dir = path.dirname(longTermPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(longTermPath, merged, 'utf-8')
      } catch {
        mergeFailed = true
      }

      // Move daily to archive/
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true })
      const archivedFilename = `${targetDate}.md`
      fs.renameSync(dailyFile, path.join(archiveDir, archivedFilename))

      return c.json({
        ok: true,
        archived: true,
        archived_date: targetDate,
        archived_filename: archivedFilename,
        merge_failed: mergeFailed,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * POST /memory/refine — Auto-refine long-term memory (PRD J5)
   * Consolidates redundant entries, trims to budget, backs up before modifying.
   */
  memory.post('/memory/refine', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      // Safe mode blocks memory refinement
      const configManager = getConfigManager()
      const config = configManager.getConfig(org)
      if (config.safe_mode.enabled) {
        return c.json(
          createAgentError('SAFE_MODE_READONLY', 'Safe mode is enabled. Memory refinement is blocked.'),
          409,
        )
      }

      const result = getMemoryService().refineLongTerm(org)
      return c.json({
        ok: true,
        refined: result.refined,
        before_tokens: result.before_tokens,
        after_tokens: result.after_tokens,
        backup_path: result.backup_path,
        saved_tokens: result.before_tokens - result.after_tokens,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return memory
}
