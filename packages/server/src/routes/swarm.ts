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

  return router
}
