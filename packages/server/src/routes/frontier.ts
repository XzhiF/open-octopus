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

  return router
}
