import { Hono } from 'hono'
import { WorkflowAnalyzer } from '../services/analysis/workflow-analyzer'
import { RetireAnalyzer } from '../services/analysis/retire-analyzer'

export function createAnalysisRoutes(
  workflowAnalyzer: WorkflowAnalyzer,
  retireAnalyzer: RetireAnalyzer,
): Hono {
  const router = new Hono()

  // GET /api/analysis/inefficient?days=30&topN=10
  router.get('/inefficient', (c) => {
    try {
      const days = parseInt(c.req.query('days') || '30', 10)
      const topN = parseInt(c.req.query('topN') || '10', 10)
      const items = workflowAnalyzer.analyzeInefficientWorkflows(days, topN)
      return c.json({ items, count: items.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/analysis/retire?days=90&usageThreshold=0.05&failureThreshold=0.5&org=default
  router.get('/retire', (c) => {
    try {
      const days = parseInt(c.req.query('days') || '90', 10)
      const usageThreshold = parseFloat(c.req.query('usageThreshold') || '0.05')
      const failureThreshold = parseFloat(c.req.query('failureThreshold') || '0.5')
      const org = c.req.query('org') || 'default'
      const candidates = retireAnalyzer.analyzeRetireCandidates(days, usageThreshold, failureThreshold, org)
      return c.json({ candidates, count: candidates.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /api/analysis/retire/protected?org=<org>
  router.get('/retire/protected', (c) => {
    try {
      const org = c.req.query('org') || 'default'
      const items = retireAnalyzer.getRetireProtected(org)
      return c.json({ org, retire_protected: items })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return router
}
