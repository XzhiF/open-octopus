import crypto from 'crypto'
import { EvolutionConfigService } from '../scheduler/evolution-config'

// ── Types ──────────────────────────────────────────────────────────

export interface Proposal {
  id: string
  title: string
  problem: string
  solution: string
  feasibilityScore: number
  verificationMethod: string
}

// ── ProposalGenerator ──────────────────────────────────────────────

export class ProposalGenerator {
  private configService: EvolutionConfigService

  constructor(configService: EvolutionConfigService) {
    this.configService = configService
  }

  /**
   * Generate evolution proposals based on configured exploration scope.
   *
   * @param org    Organization name
   * @param count  Number of proposals to generate (default: 3-5 random)
   * @throws "No exploration direction configured" if evolution_scope is empty
   */
  generateProposals(org: string, count?: number): Proposal[] {
    const scopes = this.configService.getEvolutionScope(org)
    if (scopes.length === 0) {
      throw new Error('No exploration direction configured')
    }

    // Default count: 3-5 random
    const numProposals = count ?? (3 + Math.floor(Math.random() * 3))
    const proposals: Proposal[] = []

    for (let i = 0; i < numProposals; i++) {
      // Round-robin through scopes
      const scope = scopes[i % scopes.length]
      proposals.push(this.buildProposal(scope, i))
    }

    return proposals
  }

  /**
   * Build a single proposal for a given scope direction.
   * ponytail: template-based generation — replace with LLM when Agent SDK is wired.
   */
  private buildProposal(scope: string, index: number): Proposal {
    const id = crypto.randomUUID()
    return {
      id,
      title: `Evolution: ${scope} improvement #${index + 1}`,
      problem: `Current ${scope} capabilities have room for improvement based on usage patterns and frontier analysis.`,
      solution: `Explore ${scope} enhancements: integrate latest patterns, optimize existing workflows, and add new capabilities aligned with the ${scope} direction.`,
      feasibilityScore: Math.round(60 + Math.random() * 35),
      verificationMethod: `Run existing test suite and measure ${scope} metrics before/after implementation.`,
    }
  }
}
