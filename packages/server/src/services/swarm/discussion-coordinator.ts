import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// ── Types ──────────────────────────────────────────────────────────

export interface ExpertOpinion {
  expert: string
  opinion: string
  confidence: number
}

export interface DiscussionResult {
  id: string
  topic: string
  expertOpinions: ExpertOpinion[]
  finalProposal: string
  conversationLog: string
}

// ── DiscussionCoordinator ──────────────────────────────────────────

const MAX_EXPERTS = 5

// Known expert roles (ponytail: hardcoded list, replace with agent registry lookup when available)
const KNOWN_ROLES = new Set([
  'architect', 'security', 'product', 'tester', 'reviewer',
  'frontend', 'backend', 'devops', 'dba', 'ux',
  'engineering-manager', 'tech-lead', 'qa', 'performance',
])

export class DiscussionCoordinator {
  private logDir: string

  /** Override logDir for testing. Defaults to ~/.octopus/discussions */
  constructor(logDir?: string) {
    this.logDir = logDir ?? path.join(
      process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus'),
      'discussions',
    )
  }

  /**
   * Start a multi-expert discussion on a topic.
   * Expert limit: 5 — rejects with error if exceeded.
   * Validates expert roles against known registry.
   *
   * ponytail: Agent SDK integration is a TODO — each expert currently
   * generates a placeholder opinion. Replace the generateOpinion() call
   * with a real Agent SDK invocation when ready.
   */
  async startDiscussion(topic: string, experts: string[]): Promise<DiscussionResult> {
    if (experts.length > MAX_EXPERTS) {
      throw new Error(`Expert limit is ${MAX_EXPERTS}, got ${experts.length}`)
    }
    if (experts.length === 0) {
      throw new Error('At least one expert is required')
    }
    // Validate roles
    for (const role of experts) {
      if (!KNOWN_ROLES.has(role)) {
        throw new Error(`Agent not found: ${role}`)
      }
    }

    const id = crypto.randomUUID()
    const opinions: ExpertOpinion[] = []
    const logLines: string[] = []

    const ts = () => new Date().toISOString()
    logLines.push(JSON.stringify({ ts: ts(), event: 'start', topic, experts }))

    // Each expert generates their opinion
    for (const expert of experts) {
      const opinion = await this.generateOpinion(topic, expert)
      opinions.push(opinion)
      logLines.push(JSON.stringify({
        ts: ts(),
        event: 'opinion',
        expert,
        opinion: opinion.opinion,
        confidence: opinion.confidence,
      }))
    }

    // Host synthesizes a final proposal
    const finalProposal = this.synthesizeProposal(topic, opinions)
    logLines.push(JSON.stringify({
      ts: ts(),
      event: 'synthesis',
      finalProposal,
    }))
    logLines.push(JSON.stringify({ ts: ts(), event: 'end' }))

    const conversationLog = logLines.join('\n')

    // Save conversation log to JSONL file
    fs.mkdirSync(this.logDir, { recursive: true })
    fs.writeFileSync(
      path.join(this.logDir, `${id}.jsonl`),
      conversationLog,
      'utf-8',
    )

    return { id, topic, expertOpinions: opinions, finalProposal, conversationLog }
  }

  /**
   * Generate a placeholder expert opinion.
   * TODO: Replace with Agent SDK invocation for real expert analysis.
   */
  private async generateOpinion(topic: string, expert: string): Promise<ExpertOpinion> {
    // Simulate async work
    await new Promise(r => setTimeout(r, 10))
    return {
      expert,
      opinion: `[${expert}] Analysis of "${topic}": From the ${expert} perspective, this topic requires careful consideration of trade-offs and implementation feasibility.`,
      confidence: 0.7,
    }
  }

  /**
   * Synthesize a final proposal from expert opinions.
   * ponytail: simple concatenation — replace with LLM synthesis when Agent SDK is wired.
   */
  private synthesizeProposal(topic: string, opinions: ExpertOpinion[]): string {
    const parts = opinions.map(o => `- **${o.expert}** (confidence: ${o.confidence}): ${o.opinion}`)
    return [
      `## Proposal: ${topic}`,
      '',
      '### Expert Opinions',
      ...parts,
      '',
      '### Synthesis',
      `Based on ${opinions.length} expert opinions, the recommended approach combines the key insights from each perspective into a balanced implementation plan.`,
    ].join('\n')
  }
}
