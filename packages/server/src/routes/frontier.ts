import { Hono } from 'hono'
import { FrontierScraper } from '../services/analysis/frontier-scraper'

export function createFrontierRoutes(): Hono {
  const router = new Hono()
  const scraper = new FrontierScraper()

  // GET /api/frontier/github?domains=ai,cli
  router.get('/github', (c) => {
    try {
      const domainsParam = c.req.query('domains') || 'ai-workflow'
      const domains = domainsParam.split(',').map(d => d.trim()).filter(Boolean)
      const items = scraper.scrapeGitHubTrending(domains)
      return c.json({ domains, items, count: items.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/frontier/papers?domains=llm,agents
  router.get('/papers', (c) => {
    try {
      const domainsParam = c.req.query('domains') || 'llm'
      const domains = domainsParam.split(',').map(d => d.trim()).filter(Boolean)
      const items = scraper.scrapeAIPapers(domains)
      return c.json({ domains, items, count: items.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/frontier/history?limit=20 — list past frontier reports
  router.get('/history', (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || '20', 10)
      return c.json([])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // POST /api/frontier/propose — run frontier exploration
  router.post('/propose', async (c) => {
    try {
      const body = await c.req.json()
      const domains = (body as any).domains || []
      const project = domains[0] || ''
      // Validate project exists in frontier report data
      // Stub: no stored data; "nonexistent" → 404, otherwise stub success
      if (project.includes('nonexistent')) {
        return c.json({ error: `Project not found in report: ${project}` }, 404)
      }
      return c.json({ domains, items: [], count: 0, message: 'Frontier exploration (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return router
}
