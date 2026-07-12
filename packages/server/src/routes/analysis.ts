import { Hono } from 'hono'
import { WorkflowAnalyzer } from '../services/analysis/workflow-analyzer'
import { RetireAnalyzer } from '../services/analysis/retire-analyzer'
import { existsSync } from 'fs'
import { join } from 'path'

export function createAnalysisRoutes(
  workflowAnalyzer: WorkflowAnalyzer,
  retireAnalyzer: RetireAnalyzer,
): Hono {
  const router = new Hono()

  // GET /api/analysis/workflow-inefficient?days=30&topN=10
  router.get('/workflow-inefficient', (c) => {
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

  // Legacy alias
  router.get('/inefficient', (c) => c.redirect('/api/analysis/workflow-inefficient'))

  // GET /api/analysis/retire-candidates?days=90&usageThreshold=0.05&failureThreshold=0.5&org=default
  router.get('/retire-candidates', (c) => {
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

  // Legacy alias
  router.get('/retire', (c) => c.redirect('/api/analysis/retire-candidates'))

  // GET /api/analysis/retire-protected?org=<org>
  router.get('/retire-protected', (c) => {
    try {
      const org = c.req.query('org') || 'default'
      const items = retireAnalyzer.getRetireProtected(org)
      return c.json({ org, retire_protected: items })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // Legacy alias
  router.get('/retire/protected', (c) => c.redirect('/api/analysis/retire-protected'))

  // POST /api/analysis/workflow-apply — apply optimization, generate PR
  router.post('/workflow-apply', async (c) => {
    try {
      const body = await c.req.json()
      const workflowId = (body as any).workflowId
      if (!workflowId) return c.json({ error: 'workflowId required' }, 400)
      return c.json({ success: true, workflowId, prUrl: `mock://pr/workflow-apply-${workflowId}`, message: 'Optimization applied (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // POST /api/analysis/workflow-ab-test — A/B test comparison
  router.post('/workflow-ab-test', async (c) => {
    try {
      const body = await c.req.json()
      const workflowId = (body as any).workflowId
      if (!workflowId) return c.json({ error: 'workflowId required' }, 400)
      // Validate workflow exists
      const workflowDir = join(process.cwd(), 'packages/core-pack/workflows')
      const workflowFile = join(workflowDir, workflowId)
      const workflowFileYaml = workflowId.endsWith('.yaml') ? workflowFile : `${workflowFile}.yaml`
      if (!existsSync(workflowFile) && !existsSync(workflowFileYaml)) {
        return c.json({ error: `Workflow not found: ${workflowId}` }, 404)
      }
      return c.json({ success: true, workflowId, reportUrl: `mock://report/ab-test-${workflowId}`, baseline: {}, current: {}, message: 'A/B test generated (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  // POST /api/analysis/retire-archive — archive workflow, generate PR
  router.post('/retire-archive', async (c) => {
    try {
      const body = await c.req.json()
      const workflowId = (body as any).workflowId
      if (!workflowId) return c.json({ error: 'workflowId required' }, 400)
      // Validate workflow exists
      const workflowDir = join(process.cwd(), 'packages/core-pack/workflows')
      const workflowFile = join(workflowDir, workflowId)
      const workflowFileYaml = workflowId.endsWith('.yaml') ? workflowFile : `${workflowFile}.yaml`
      if (!existsSync(workflowFile) && !existsSync(workflowFileYaml)) {
        return c.json({ error: `Workflow not found: ${workflowId}` }, 404)
      }
      return c.json({ success: true, workflowId, prUrl: `mock://pr/retire-${workflowId}`, message: 'Workflow archived (stub)' })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 500)
    }
  })

  return router
}
