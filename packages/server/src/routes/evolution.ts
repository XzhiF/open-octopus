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
      const proposals = generator.generateProposals(org, count)
      return c.json({ org, proposals, count: proposals.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('No exploration direction') ? 400 : 500
      return c.json({ error: msg }, status)
    }
  })

  return router
}
