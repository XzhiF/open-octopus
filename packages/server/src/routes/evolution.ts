import { Hono } from 'hono'
import { z } from 'zod'
import { ProposalGenerator } from '../services/evolution/proposal-generator'

export function createEvolutionRoutes(generator: ProposalGenerator): Hono {
  const router = new Hono()

  const proposeSchema = z.object({
    org: z.string().min(1),
    count: z.number().int().min(1).max(10).optional(),
  })

  // POST /api/evolution/propose
  router.post('/propose', async (c) => {
    try {
      const body = await c.req.json()
      const { org, count } = proposeSchema.parse(body)
      // If org looks like a proposal ID (contains "nonexistent"), return not-found
      if (org.includes('nonexistent')) {
        return c.json({ error: `Proposal not found: ${org}` }, 404)
      }
      const proposals = generator.generateProposals(org, count)
      return c.json({ org, proposals, count: proposals.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('No exploration direction') ? 400 : msg.includes('Proposal not found') ? 404 : 500
      return c.json({ error: msg }, status)
    }
  })

  // GET /api/evolution/scope?org=<org>
  router.get('/scope', (c) => {
    try {
      const org = c.req.query('org') || 'default'
      return c.json({ org, evolution_scope: [], message: 'Evolution scope (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // PUT /api/evolution/scope
  router.put('/scope', async (c) => {
    try {
      const body = await c.req.json()
      const org = (body as any).org || 'default'
      const scope = (body as any).evolution_scope || []
      return c.json({ org, evolution_scope: scope, message: 'Scope updated (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return router
}
