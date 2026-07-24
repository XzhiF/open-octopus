// packages/server/src/services/archive/archive-analysis-service.ts
//
// Archive Analysis Service — extracted from OrchestratorService.
// Runs the 3-phase analysis pipeline for workspace archival.
//
import fs from 'fs'
import path from 'path'
import os from 'os'
import { getProvider } from '@octopus/providers'
import type { StepEmitter } from './step-emitter'
import { createNullEmitter } from './step-emitter'
import type { ArchivePreview, AnalysisReport, ExperienceCandidate, SkillCandidate } from './analysis-assembler'

// ── ArchiveAnalysisService ────────────────────────────────────────

export class ArchiveAnalysisService {
  private org: string

  constructor(org: string) {
    this.org = org
  }

  /**
   * Run the 3-phase archive analysis pipeline.
   * Phase 1: Build context + auto-discover resources
   * Phase 2: Parallel LLM analysis (3 calls)
   * Phase 3: Assemble results
   */
  async analyzeWorkspaceForArchive(
    workspaceId: string,
    emitter: StepEmitter = createNullEmitter(),
  ): Promise<ArchivePreview> {
    // Phase 1: Build context
    await emitter.stepStart("build_context", "构建分析上下文...")
    await emitter.log("═══ 归档分析开始 ═══")
    await emitter.log(`工作空间: ${workspaceId}`)
    const { buildArchiveContext } = await import('./context-builder')
    const { WorkspaceDAO } = await import('../../db/dao/workspace-dao')
    const { ExecutionDAO } = await import('../../db/dao/execution-dao')
    const { getDb } = await import('../../db')
    const { discoverSkillsFromWorkspace, discoverWorkflowsFromWorkspace, discoverAgentsFromWorkspace } = await import('../archive/skill-discovery')

    const db = getDb()
    const workspaceDAO = new WorkspaceDAO(db)
    const executionDAO = new ExecutionDAO(db)
    const ctx = await buildArchiveContext(workspaceId, workspaceDAO, executionDAO, db, this.org)

    if (!ctx) {
      await emitter.stepError("build_context", "工作空间未找到")
      await emitter.log("ERROR: 工作空间未找到")
      return this.emptyPreview('Workspace not found')
    }
    await emitter.log(`✓ 上下文构建完成: ${ctx.executions.length} 条执行记录, ${ctx.workflows.length} 个工作流`)
    await emitter.stepDone("build_context")

    // Phase 1.5: Auto-discover skills
    await emitter.stepStart("discover_skills", "扫描 .claude/skills/ 自动发现...")
    const rawPath = workspaceDAO.findPathById(workspaceId)
    const workspacePath = rawPath?.replace(/^~/, os.homedir()) ?? null
    const rawDiscoveredSkills = workspacePath ? discoverSkillsFromWorkspace(workspacePath) : []

    let autoDiscoveredSkills: Array<Record<string, unknown>> = []
    try {
      const { getResourceRegistry } = await import('../resource-registry')
      const resourceManager = getResourceRegistry().get()
      const installed = resourceManager.list({ type: "skill", installed: true })
      const installedMap = new Map<string, { group: string; installPath: string }>()
      for (const entry of installed.resources ?? []) {
        if (entry.installPath) installedMap.set(entry.name, { group: entry.group, installPath: entry.installPath })
      }

      const crypto = await import("crypto")
      for (const skill of rawDiscoveredSkills) {
        const existing = installedMap.get(skill.name)
        if (existing) {
          let sourceContent = ""
          try { sourceContent = fs.readFileSync(skill.path, "utf-8") } catch {}
          let existingContent = ""
          try {
            const mainFile = path.join(existing.installPath, "SKILL.md")
            if (fs.existsSync(mainFile)) existingContent = fs.readFileSync(mainFile, "utf-8")
          } catch {}
          const normalize = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd()
          if (crypto.createHash("md5").update(normalize(sourceContent)).digest("hex") ===
              crypto.createHash("md5").update(normalize(existingContent)).digest("hex")) {
            continue
          }
          autoDiscoveredSkills.push({ ...skill, auto_discovered: true, status: "updated", existingGroup: existing.group })
        } else {
          autoDiscoveredSkills.push({ ...skill, auto_discovered: true, status: "new", existingGroup: null })
        }
      }
    } catch {
      autoDiscoveredSkills = rawDiscoveredSkills.map(s => ({ ...s, auto_discovered: true, status: "new", existingGroup: null }))
    }
    await emitter.log(`✓ 发现 ${autoDiscoveredSkills.length} 个 Skill`)
    await emitter.stepDone("discover_skills")

    // Phase 1.6-1.7: Auto-discover workflows + agents (abbreviated)
    const rawDiscoveredWorkflows = workspacePath ? discoverWorkflowsFromWorkspace(workspacePath) : []
    const rawDiscoveredAgents = workspacePath ? discoverAgentsFromWorkspace(workspacePath) : []

    // Phase 2: Parallel LLM analysis
    await emitter.stepStart("analyze_parallel", "3 个 LLM 并行分析中...")
    const { buildRetrospectivePrompt, buildExperiencePrompt, buildSkillDiscoveryPrompt } = await import('./prompts')
    const { assembleAnalysis } = await import('./analysis-assembler')

    const [reportResult, experienceResult, skillResult] = await Promise.allSettled([
      this.callArchiveLLM(buildRetrospectivePrompt(ctx), 'You are an expert engineering analyst.'),
      this.callArchiveLLM(buildExperiencePrompt(ctx), 'You are a knowledge extraction engine. Respond with only the JSON array.'),
      this.callArchiveLLM(buildSkillDiscoveryPrompt(ctx), 'You are a skill discovery agent. Respond with only the JSON array.'),
    ])

    const report = parseReport(reportResult)
    const experiences = parseExperiences(experienceResult)
    const llmSkills = parseSkills(skillResult)
    await emitter.stepDone("analyze_parallel")

    // Merge auto-discovered + LLM skills
    const autoNames = new Set(autoDiscoveredSkills.map(s => s.name))
    const mergedSkills = [...autoDiscoveredSkills, ...llmSkills.filter(s => !autoNames.has(s.name))]

    // Phase 2.5: Token stats
    let tokenStats: any = { total: { inputTokens: 0, outputTokens: 0, cost: 0 }, byModel: [], byWorkflow: [], nodes: [] }
    try {
      const { TokenUsageDAO } = await import('../../db/dao/token-usage-dao')
      const tokenDAO = new TokenUsageDAO(db)
      const wsStats = tokenDAO.getWorkspaceTokenStats(workspaceId)
      const nodes = tokenDAO.getNodeTokenStats(workspaceId)
      tokenStats = { ...wsStats, nodes }
    } catch { /* non-fatal */ }

    // Phase 3: Assemble
    await emitter.stepStart("assemble", "合并分析结果...")
    const preview = assembleAnalysis(ctx, report, experiences, mergedSkills)
    ;(preview as any).tokenStats = tokenStats
    ;(preview as any).workflows = rawDiscoveredWorkflows
    ;(preview as any).agents = rawDiscoveredAgents
    await emitter.stepDone("assemble")

    // Save draft
    try {
      const { ArchiveDraftDAO } = await import('../../db/dao/archive-draft-dao')
      const archiveDraftDAO = new ArchiveDraftDAO(db)
      archiveDraftDAO.upsert({
        workspace_id: workspaceId,
        org: this.org,
        analysis_report: JSON.stringify(preview.analysis),
        experiences: JSON.stringify(preview.experiences),
        skills: JSON.stringify(preview.skills),
        stats: JSON.stringify(preview.stats),
        workflows: JSON.stringify((preview as any).workflows ?? []),
        token_stats: JSON.stringify((preview as any).tokenStats ?? {}),
        agents: JSON.stringify((preview as any).agents ?? []),
      })
    } catch { /* non-fatal */ }

    await emitter.log("═══ 归档分析完成 ═══")
    return preview
  }

  private async callArchiveLLM(prompt: string, systemPrompt: string): Promise<string> {
    try {
      const provider = getProvider('claude')
      const chunks: string[] = []
      const stream = provider.sendQuery(prompt, process.cwd(), undefined, { systemPrompt })
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') chunks.push(chunk.content)
      }
      return chunks.join('')
    } catch {
      return ''
    }
  }

  private emptyPreview(reason: string): ArchivePreview {
    return {
      stats: { execution_count: 0, success_rate: 0, total_cost: 0, total_duration_ms: 0, avg_cost_per_execution: 0, avg_duration_ms: 0, lifespan_days: 0, workflow_count: 0 },
      analysis: { summary: reason, execution_patterns: [], cost_efficiency: { rating: 'moderate', analysis: '', optimization_ideas: [] }, error_patterns: [], recommendations: [] },
      experiences: [],
      skills: [],
    }
  }
}

// ── Parse helpers ──────────────────────────────────────────────────

function parseReport(result: PromiseSettledResult<string>): AnalysisReport {
  const fallback: AnalysisReport = { summary: 'Analysis unavailable', execution_patterns: [], cost_efficiency: { rating: 'moderate', analysis: '', optimization_ideas: [] }, error_patterns: [], recommendations: [] }
  if (result.status !== 'fulfilled' || !result.value) return fallback
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      summary: parsed.summary || fallback.summary,
      execution_patterns: toStringArray(parsed.execution_patterns),
      cost_efficiency: normalizeCostEfficiency(parsed.cost_efficiency),
      error_patterns: toStringArray(parsed.error_patterns),
      recommendations: toStringArray(parsed.recommendations),
    }
  } catch {
    return { ...fallback, summary: result.value.slice(0, 500) || 'Analysis parse failed' }
  }
}

function toStringArray(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item))
}

function normalizeCostEfficiency(raw: unknown): AnalysisReport['cost_efficiency'] {
  const fallback = { rating: 'moderate', analysis: '', optimization_ideas: [] as string[] }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>
  return {
    rating: String(obj.rating || 'moderate'),
    analysis: String(obj.analysis || ''),
    optimization_ideas: toStringArray(obj.optimization_ideas || []),
  }
}

function parseExperiences(result: PromiseSettledResult<string>): ExperienceCandidate[] {
  if (result.status !== 'fulfilled' || !result.value) return []
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return []
    return arr.map((e: any, i: number) => ({
      id: e.id || `exp-${i}`, text: e.text || '', scope: e.scope || 'project',
      target: e.target || '', confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      evidence: e.evidence || '', category: e.category || 'process',
      conflicts: Array.isArray(e.conflicts) ? e.conflicts : [],
      action: (['add', 'update', 'delete'].includes(e.action) ? e.action : 'add') as 'add' | 'update' | 'delete',
    }))
  } catch { return [] }
}

function parseSkills(result: PromiseSettledResult<string>): SkillCandidate[] {
  if (result.status !== 'fulfilled' || !result.value) return []
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return []
    return arr.map((s: any) => ({
      name: s.name || '', description: s.description || '',
      content_outline: Array.isArray(s.content_outline) ? s.content_outline : [],
      reason: s.reason || '',
      evidence_workflows: Array.isArray(s.evidence_workflows) ? s.evidence_workflows : [],
      evidence_executions: Array.isArray(s.evidence_executions) ? s.evidence_executions : [],
      estimated_reuse: s.estimated_reuse || 'low',
    }))
  } catch { return [] }
}

// ── Singleton ──────────────────────────────────────────────────────

const instances = new Map<string, ArchiveAnalysisService>()

export function getArchiveAnalysisService(org: string): ArchiveAnalysisService {
  let instance = instances.get(org)
  if (!instance) {
    instance = new ArchiveAnalysisService(org)
    instances.set(org, instance)
  }
  return instance
}
