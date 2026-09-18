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
      const source = c.req.query('source') // Optional: 'main' | clone-name
      let results: unknown[]
      let degraded = false
      try {
        results = getMemoryService().searchMemory(org, query, parseInt(c.req.query('top_k') ?? '3', 10), source)
      } catch {
        // FTS index may be corrupted — auto-trigger rebuild and retry with LIKE
        degraded = true
        try {
          getMemoryService().rebuildFtsIndex(org)
          results = getMemoryService().searchMemory(org, query, parseInt(c.req.query('top_k') ?? '3', 10), source)
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

      // Daily layer returns all daily files as an array
      if (layer === 'daily') {
        const items = getMemoryService().readDailyAll(org)
        return c.json(items)
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




  return memory
}
