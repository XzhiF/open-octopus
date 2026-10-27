import { Hono } from 'hono'
import {
  getPersonaService,
  PersonaTooLongError,
  PersonaEmptyError,
} from '../../services/agent/persona-service'
import {
  getMainAgentPresetState,
  setMainAgentPreset,
  type MainAgentPresetId,
} from '../../services/agent/main-agent-preset'
import { createAgentError, mapErrorToStatus } from './middleware'

export function createPersonaRoutes(): Hono {
  const persona = new Hono()

  /**
   * GET /config/persona — Read persona.md content
   */
  persona.get('/config/persona', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const result = getPersonaService().readPersona(org)
      return c.json(result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * PUT /config/persona — Update persona.md content
   */
  persona.put('/config/persona', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const body = await c.req.json<{ content: string }>()

      if (!body || typeof body.content !== 'string') {
        return c.json(
          createAgentError('INVALID_PARAM', 'Request body must include "content" as a string'),
          400,
        )
      }

      const result = getPersonaService().writePersona(org, body.content)
      return c.json({ ok: true, token_count: result.token_count })
    } catch (err: unknown) {
      if (err instanceof PersonaTooLongError) {
        return c.json(
          createAgentError('PERSONA_TOO_LONG', err.message, {
            current_length: err.currentLength,
            max_length: err.maxLength,
          }),
          413,
        )
      }
      if (err instanceof PersonaEmptyError) {
        return c.json(createAgentError('INVALID_PARAM', err.message), 400)
      }

      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /config/main-preset — Main-agent identity preset state.
   * `active` is detected from the current persona.md content (hash match) and
   * falls back to 'custom' for a hand-edited file.
   */
  persona.get('/config/main-preset', (c) => {
    try {
      return c.json(getMainAgentPresetState())
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * PUT /config/main-preset — Switch the main-agent persona source.
   * Writes persona.md (backing the outgoing file up first). New sessions only:
   * frozen system-prompt snapshots are never touched, so the provider prefix
   * cache survives the switch.
   */
  persona.put('/config/main-preset', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }
      const body = await c.req.json<{ preset?: unknown }>().catch(() => ({} as { preset?: unknown }))
      const preset = typeof body.preset === 'string' ? (body.preset as MainAgentPresetId) : null
      if (!preset) {
        return c.json(createAgentError('INVALID_PARAM', 'Request body must include "preset"'), 400)
      }

      const result = setMainAgentPreset(preset, org)
      return c.json({ ok: true, ...result, ...getMainAgentPresetState() })
    } catch (err: unknown) {
      if (err instanceof PersonaTooLongError) {
        return c.json(
          createAgentError('PERSONA_TOO_LONG', err.message, {
            current_length: err.currentLength,
            max_length: err.maxLength,
          }),
          413,
        )
      }
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return persona
}
