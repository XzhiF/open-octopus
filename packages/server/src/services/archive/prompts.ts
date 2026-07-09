import type { ArchiveContext } from "./context-builder"

// ── buildRetrospectivePrompt ────────────────────────────────────────────────

export function buildRetrospectivePrompt(ctx: ArchiveContext): string {
  const { workspace, executions, workflows, errorCatalog, costProfile } = ctx

  const totalExecs = executions.length
  const successCount = executions.filter((e) => e.status === "completed").length
  const failCount = executions.filter((e) => e.status === "failed").length
  const totalCost = costProfile.total_cost
  const totalDuration = executions.reduce((sum, e) => sum + e.duration_s, 0)
  const successRate = totalExecs > 0 ? Math.round((successCount / totalExecs) * 100) : 0

  const workflowBreakdown = workflows
    .map((wf) => {
      const successRateStr = `${Math.round(wf.successRate * 100)}%`
      return [
        `  - ${wf.name}:`,
        `    Executions: ${wf.count}, Success: ${wf.successCount}, Failed: ${wf.failCount}, Rate: ${successRateStr}`,
        `    Avg Cost: $${wf.avgCost.toFixed(4)}, Avg Duration: ${wf.avgDuration_s.toFixed(1)}s`,
        `    Cost Trend: ${wf.costTrendDirection} (${wf.costTrend})`,
        `    Node Types: ${wf.nodeTypes.join(", ") || "none"}`,
      ].join("\n")
    })
    .join("\n")

  const errorSection =
    errorCatalog.length > 0
      ? errorCatalog
          .map(
            (err) =>
              `  - Node: ${err.node_id}, Workflow: ${err.workflow_name}, Frequency: ${err.frequency}, ` +
              `Last: ${err.lastOccurred}\n    Error: ${err.errorSnippet}`,
          )
          .join("\n")
      : "  No errors recorded."

  const modelBreakdown =
    costProfile.modelBreakdown.length > 0
      ? costProfile.modelBreakdown
          .map(
            (m) =>
              `  - ${m.model}: Calls=${m.calls}, Tokens=${m.tokens}, Cost=$${m.cost.toFixed(4)}`,
          )
          .join("\n")
      : "  No model usage recorded."

  return `You are an expert engineering analyst performing a deep workspace retrospective.
Analyze the following workspace data and produce a structured JSON report.

═══════════════════════════════════════════════════════
WORKSPACE METADATA
═══════════════════════════════════════════════════════
Name: ${workspace.name}
Organization: ${workspace.org}
Lifespan: ${workspace.lifespan_days} days
Description: ${workspace.description ?? "No description"}
Created: ${workspace.created_at}
Updated: ${workspace.updated_at}

═══════════════════════════════════════════════════════
EXECUTION OVERVIEW
═══════════════════════════════════════════════════════
Total Executions: ${totalExecs}
Successful: ${successCount} | Failed: ${failCount} | Success Rate: ${successRate}%
Total Cost: $${totalCost.toFixed(4)}
Total Compute Time: ${totalDuration.toFixed(1)}s

═══════════════════════════════════════════════════════
PER-WORKFLOW BREAKDOWN
═══════════════════════════════════════════════════════
${workflowBreakdown || "  No workflows recorded."}

═══════════════════════════════════════════════════════
ERROR CATALOG (top failures by frequency)
═══════════════════════════════════════════════════════
${errorSection}

═══════════════════════════════════════════════════════
COST DISTRIBUTION BY MODEL
═══════════════════════════════════════════════════════
${modelBreakdown}

═══════════════════════════════════════════════════════
COST TREND
═══════════════════════════════════════════════════════
Daily Average: $${costProfile.daily_avg.toFixed(4)}
Direction: ${costProfile.trend_direction}
Trend: ${costProfile.trend_pct.toFixed(1)}%

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY valid JSON with these keys:
{
  "summary": "One-paragraph executive summary of the workspace health and key findings",
  "execution_patterns": [
    "Identified patterns in how workflows are executed (e.g., failure clustering, timing trends)"
  ],
  "cost_efficiency": {
    "rating": "good|moderate|poor",
    "analysis": "Assessment of cost vs. output efficiency",
    "top_model": "Most cost-effective model",
    "optimization_ideas": ["Specific cost reduction suggestions"]
  },
  "error_patterns": [
    {
      "pattern": "Description of recurring error pattern",
      "root_cause": "Likely root cause",
      "frequency": 0,
      "suggested_fix": "Recommended mitigation"
    }
  ],
  "workflow_health": [
    {
      "workflow": "workflow-name",
      "status": "healthy|at-risk|unhealthy",
      "concerns": ["Specific concerns"],
      "strengths": ["What works well"]
    }
  ],
  "recommendations": [
    "Prioritized actionable recommendations for improving the workspace"
  ]
}

Analyze the data thoroughly. Be specific and data-driven. Do not invent data not present in the context.`
}

// ── buildExperiencePrompt ───────────────────────────────────────────────────

export function buildExperiencePrompt(ctx: ArchiveContext): string {
  const { workspace, executions, errorCatalog, existingKnowledge } = ctx

  const executionHistory = executions
    .map((exec) => {
      const failedNodesStr =
        exec.failedNodes.length > 0
          ? exec.failedNodes.map((fn) => `      - ${fn.node_id} (${fn.node_type}): ${fn.errorSnippet}`).join("\n")
          : "      No failures"
      return [
        `  [${exec.index}] ${exec.workflow_name} | ${exec.status} | ${exec.duration_s.toFixed(1)}s | $${exec.cost.toFixed(4)} | ${exec.started_at}`,
        `    Failed Nodes:`,
        failedNodesStr,
      ].join("\n")
    })
    .join("\n")

  const errorFrequency =
    errorCatalog.length > 0
      ? errorCatalog
          .map(
            (err) =>
              `  - ${err.node_id} in ${err.workflow_name}: ${err.frequency} occurrences, last: ${err.lastOccurred}\n    Error: ${err.errorSnippet}`,
          )
          .join("\n")
      : "  No errors recorded."

  const knowledgeRules =
    existingKnowledge.length > 0
      ? existingKnowledge.map((r) => `  - [${r.id}] (${r.scope}) ${r.text}`).join("\n")
      : "  No existing knowledge rules."

  return `You are an expert knowledge engineer extracting cross-execution lessons from a workspace archive.
Identify reusable experiences that apply across multiple executions, not just single incidents.

═══════════════════════════════════════════════════════
WORKSPACE METADATA
═══════════════════════════════════════════════════════
Name: ${workspace.name}
Organization: ${workspace.org}
Lifespan: ${workspace.lifespan_days} days
Description: ${workspace.description ?? "No description"}

═══════════════════════════════════════════════════════
EXECUTION HISTORY (chronological)
═══════════════════════════════════════════════════════
${executionHistory || "  No executions recorded."}

═══════════════════════════════════════════════════════
ERROR FREQUENCY ANALYSIS
═══════════════════════════════════════════════════════
${errorFrequency}

═══════════════════════════════════════════════════════
EXISTING KNOWLEDGE RULES (avoid conflicts with these)
═══════════════════════════════════════════════════════
${knowledgeRules}

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY a JSON array of experience objects (max 15):
[
  {
    "text": "Imperative sentence: a clear instruction or lesson learned (e.g., 'Always validate config files before running deploy workflows')",
    "scope": "workspace|workflow|node",
    "target": "The workflow name, node_id, or 'all' this experience applies to",
    "confidence": 0.0-1.0,
    "evidence": "Brief description of what executions support this",
    "category": "error-prevention|cost-optimization|pattern-improvement|reliability|efficiency",
    "conflicts": ["ids of existing knowledge rules this conflicts with, if any"]
  }
]

RULES:
- Extract at most 15 experiences.
- Each "text" must be an imperative sentence — a direct instruction.
- Prioritize cross-execution patterns: if the same issue appears in 2+ executions, it is high-confidence.
- Avoid duplicating or contradicting existing knowledge rules. If a conflict exists, list the conflicting rule id in "conflicts".
- Focus on actionable lessons that prevent errors, reduce cost, or improve patterns.
- Do NOT include experiences that are trivially specific to a single execution with no repetition signal.
- If there is insufficient data to extract meaningful cross-execution patterns, return an empty array [].`
}

// ── buildSkillDiscoveryPrompt ───────────────────────────────────────────────

export function buildSkillDiscoveryPrompt(ctx: ArchiveContext): string {
  const { workspace, workflows, nodePatterns, executions } = ctx

  const workflowDetails = workflows
    .map(
      (wf) =>
        `  - ${wf.name}: ${wf.count} executions, node types=[${wf.nodeTypes.join(", ")}], ` +
        `success=${Math.round(wf.successRate * 100)}%`,
    )
    .join("\n")

  const topNodePatterns = nodePatterns.slice(0, 15)
  const nodePatternSection =
    topNodePatterns.length > 0
      ? topNodePatterns
          .map(
            (np) =>
              `  - ${np.node_id} (${np.node_type}): frequency=${np.frequency}, ` +
              `success=${Math.round(np.successRate * 100)}%, avg=${np.avgDuration_s.toFixed(1)}s, ` +
              `workflows=[${np.workflowNames.join(", ")}]`,
          )
          .join("\n")
      : "  No node patterns recorded."

  const failedNodeInterventions = executions
    .flatMap((exec) =>
      exec.failedNodes.map((fn) => ({
        ...fn,
        workflow_name: exec.workflow_name,
        started_at: exec.started_at,
      })),
    )
  const interventionSection =
    failedNodeInterventions.length > 0
      ? failedNodeInterventions
          .map(
            (fi) =>
              `  - ${fi.node_id} (${fi.node_type}) in ${fi.workflow_name}: ${fi.errorSnippet}`,
          )
          .join("\n")
      : "  No failed node interventions recorded."

  return `You are an expert skill engineer identifying reusable skill candidates from workspace execution patterns.
Skills are modular, reusable capabilities that can be extracted from repeated workflow patterns.

═══════════════════════════════════════════════════════
WORKSPACE METADATA
═══════════════════════════════════════════════════════
Name: ${workspace.name}
Organization: ${workspace.org}
Lifespan: ${workspace.lifespan_days} days
Description: ${workspace.description ?? "No description"}

═══════════════════════════════════════════════════════
WORKFLOWS (with node types and patterns)
═══════════════════════════════════════════════════════
${workflowDetails || "  No workflows recorded."}

═══════════════════════════════════════════════════════
MOST-USED NODE PATTERNS (top 15)
═══════════════════════════════════════════════════════
${nodePatternSection}

═══════════════════════════════════════════════════════
REPEATED MANUAL INTERVENTIONS (from failed nodes)
═══════════════════════════════════════════════════════
${interventionSection}

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY a JSON array of skill candidate objects (0-5 candidates):
[
  {
    "name": "kebab-case-skill-name",
    "description": "What this skill does and when to use it",
    "content_outline": [
      "Step 1: ...",
      "Step 2: ...",
      "Step 3: ..."
    ],
    "reason": "Why this skill should be extracted from the patterns observed",
    "evidence_workflows": ["workflow-name-1", "workflow-name-2"],
    "evidence_executions": 0,
    "estimated_reuse": "high|medium|low"
  }
]

RULES:
- Return between 0 and 5 skill candidates. Zero is valid if no reusable patterns exist.
- Names must be kebab-case (e.g., "validate-deploy-config", "auto-retry-failed-tests").
- Only propose skills that appear in at least 2 workflows or executions (genuine reuse signal).
- Each skill should encapsulate a pattern that reduces manual effort or prevents recurring errors.
- "content_outline" should be a sequence of concrete steps the skill would automate or guide.
- "estimated_reuse" should be "high" if the pattern appears in 3+ workflows, "medium" for 2, "low" for borderline cases.
- Do NOT propose skills that are too generic (e.g., "run-tests", "write-code") — they must be specific to observed patterns.
- If the workspace has insufficient or no repeated patterns, return an empty array [].`
}
