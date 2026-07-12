import { Hono } from 'hono'
import { z } from 'zod'
import { DiscussionCoordinator } from '../services/swarm/discussion-coordinator'

export function createSwarmRoutes(coordinator: DiscussionCoordinator): Hono {
  const router = new Hono()

  const discussSchema = z.object({
    topic: z.string().min(1),
    experts: z.array(z.string()).min(1),
  })

  // POST /api/swarm/discuss
  router.post('/discuss', async (c) => {
    try {
      const body = await c.req.json()
      const { topic, experts } = discussSchema.parse(body)
      const result = await coordinator.startDiscussion(topic, experts)
      return c.json(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 400)
    }
  })

  // POST /api/swarm/sync-chatbot — sync discussion to chatbot
  router.post('/sync-chatbot', async (c) => {
    try {
      const body = await c.req.json()
      const discussionId = (body as any).discussionId
      if (!discussionId) return c.json({ error: 'discussionId required' }, 400)
      return c.json({ success: true, syncedAt: new Date().toISOString(), message: 'Synced to chatbot (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/swarm/discussion/:id
  router.get('/discussion/:id', (c) => {
    try {
      const id = c.req.param('id')
      return c.json({ id, topic: 'stub', expertOpinions: [], finalProposal: '', conversationLog: '', error: 'Discussion not found' }, 404)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return router
}
