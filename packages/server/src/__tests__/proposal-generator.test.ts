import { describe, it, expect, vi } from 'vitest'
import { ProposalGenerator } from '../services/evolution/proposal-generator'
import { EvolutionConfigService } from '../services/scheduler/evolution-config'

// Mock EvolutionConfigService
vi.mock('../services/scheduler/evolution-config', () => ({
  EvolutionConfigService: vi.fn().mockImplementation(() => ({
    getEvolutionScope: vi.fn(),
  })),
}))

function makeConfigService(scopes: string[]): EvolutionConfigService {
  const svc = new EvolutionConfigService()
  vi.mocked(svc.getEvolutionScope).mockReturnValue(scopes)
  return svc
}

describe('ProposalGenerator', () => {
  // ── No-scope error ──────────────────────────────────────────────

  it('throws when no exploration direction is configured', () => {
    const gen = new ProposalGenerator(makeConfigService([]))
    expect(() => gen.generateProposals('myorg')).toThrow('No exploration direction configured')
  })

  // ── Count parameter ─────────────────────────────────────────────

  it('generates the requested number of proposals', () => {
    const gen = new ProposalGenerator(makeConfigService(['ai', 'devops']))

    expect(gen.generateProposals('org', 1)).toHaveLength(1)
    expect(gen.generateProposals('org', 5)).toHaveLength(5)
    expect(gen.generateProposals('org', 10)).toHaveLength(10)
  })

  it('defaults to 3-5 proposals when count is omitted', () => {
    const gen = new ProposalGenerator(makeConfigService(['scope-a']))
    const proposals = gen.generateProposals('org')

    expect(proposals.length).toBeGreaterThanOrEqual(3)
    expect(proposals.length).toBeLessThanOrEqual(5)
  })

  // ── Scope filtering / round-robin ───────────────────────────────

  it('round-robins through configured scopes', () => {
    const gen = new ProposalGenerator(makeConfigService(['alpha', 'beta']))
    const proposals = gen.generateProposals('org', 4)

    expect(proposals[0].title).toContain('alpha')
    expect(proposals[1].title).toContain('beta')
    expect(proposals[2].title).toContain('alpha')
    expect(proposals[3].title).toContain('beta')
  })

  it('uses the single scope for all proposals when only one is configured', () => {
    const gen = new ProposalGenerator(makeConfigService(['only-scope']))
    const proposals = gen.generateProposals('org', 3)

    for (const p of proposals) {
      expect(p.title).toContain('only-scope')
      expect(p.problem).toContain('only-scope')
      expect(p.solution).toContain('only-scope')
    }
  })

  it('passes org to getEvolutionScope', () => {
    const svc = makeConfigService(['x'])
    const gen = new ProposalGenerator(svc)

    gen.generateProposals('my-org', 1)

    expect(svc.getEvolutionScope).toHaveBeenCalledWith('my-org')
  })

  // ── Feasibility scoring ─────────────────────────────────────────

  it('assigns feasibilityScore between 60 and 95', () => {
    const gen = new ProposalGenerator(makeConfigService(['test']))
    const proposals = gen.generateProposals('org', 20)

    for (const p of proposals) {
      expect(p.feasibilityScore).toBeGreaterThanOrEqual(60)
      expect(p.feasibilityScore).toBeLessThanOrEqual(95)
    }
  })

  // ── Proposal shape ──────────────────────────────────────────────

  it('populates all Proposal fields', () => {
    const gen = new ProposalGenerator(makeConfigService(['perf']))
    const [proposal] = gen.generateProposals('org', 1)

    expect(typeof proposal.id).toBe('string')
    expect(proposal.id.length).toBeGreaterThan(0)
    expect(typeof proposal.title).toBe('string')
    expect(typeof proposal.problem).toBe('string')
    expect(typeof proposal.solution).toBe('string')
    expect(typeof proposal.feasibilityScore).toBe('number')
    expect(typeof proposal.verificationMethod).toBe('string')
  })

  it('generates unique IDs for each proposal', () => {
    const gen = new ProposalGenerator(makeConfigService(['a', 'b']))
    const proposals = gen.generateProposals('org', 10)
    const ids = proposals.map(p => p.id)
    const uniqueIds = new Set(ids)

    expect(uniqueIds.size).toBe(ids.length)
  })

  it('includes scope in verification method', () => {
    const gen = new ProposalGenerator(makeConfigService(['security']))
    const [proposal] = gen.generateProposals('org', 1)

    expect(proposal.verificationMethod).toContain('security')
  })

  it('numbers proposals sequentially starting from 1', () => {
    const gen = new ProposalGenerator(makeConfigService(['s']))
    const proposals = gen.generateProposals('org', 3)

    expect(proposals[0].title).toContain('#1')
    expect(proposals[1].title).toContain('#2')
    expect(proposals[2].title).toContain('#3')
  })
})
