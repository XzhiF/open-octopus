import { describe, it, expect, vi, afterEach } from 'vitest'
import { FrontierScraper } from '../services/analysis/frontier-scraper'

// Mock child_process.execFileSync used inside execGh
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'child_process'
const mockExec = vi.mocked(execFileSync)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FrontierScraper', () => {
  const scraper = new FrontierScraper()

  const makeRepos = (stars: number[]) =>
    stars.map((s, i) => ({
      name: `repo-${i}`,
      url: `https://github.com/test/repo-${i}`,
      description: `desc-${i}`,
      stargazersCount: s,
    }))

  // ── Scoring normalization ──────────────────────────────────────

  it('normalizes scores relative to max stars (0-100)', () => {
    mockExec.mockReturnValueOnce(JSON.stringify(makeRepos([100, 50, 25])))

    const items = scraper.scrapeGitHubTrending(['ai'])

    expect(items).toHaveLength(3)
    expect(items[0].score).toBe(100) // 100/100
    expect(items[1].score).toBe(50)  // 50/100
    expect(items[2].score).toBe(25)  // 25/100
  })

  it('caps score at 100', () => {
    // Edge case: normalizeScore clamps at 100
    mockExec.mockReturnValueOnce(JSON.stringify([{
      name: 'mega', url: 'https://github.com/x/y',
      description: 'd', stargazersCount: 99999,
    }]))

    const items = scraper.scrapeGitHubTrending(['test'])
    expect(items[0].score).toBeLessThanOrEqual(100)
  })

  it('returns score 0 when maxStars is 0', () => {
    mockExec.mockReturnValueOnce(JSON.stringify(makeRepos([0, 0])))

    const items = scraper.scrapeGitHubTrending(['empty'])
    expect(items.every(i => i.score === 0)).toBe(true)
  })

  // ── Domain filtering ────────────────────────────────────────────

  it('queries gh CLI with --topic for each domain', () => {
    mockExec.mockReturnValue('[]')

    scraper.scrapeGitHubTrending(['ai', 'devops', 'security'])

    expect(mockExec).toHaveBeenCalledTimes(3)
    expect(mockExec.mock.calls[0][1]).toContain('--topic=ai')
    expect(mockExec.mock.calls[1][1]).toContain('--topic=devops')
    expect(mockExec.mock.calls[2][1]).toContain('--topic=security')
  })

  it('aggregates items across multiple domains', () => {
    mockExec
      .mockReturnValueOnce(JSON.stringify(makeRepos([10])))
      .mockReturnValueOnce(JSON.stringify(makeRepos([20])))

    const items = scraper.scrapeGitHubTrending(['a', 'b'])
    expect(items).toHaveLength(2)
  })

  it('returns empty array when no domains provided', () => {
    const items = scraper.scrapeGitHubTrending([])
    expect(items).toHaveLength(0)
    expect(mockExec).not.toHaveBeenCalled()
  })

  // ── JSON parse safety ───────────────────────────────────────────

  it('returns empty items on invalid JSON', () => {
    mockExec.mockReturnValueOnce('not json at all')

    const items = scraper.scrapeGitHubTrending(['test'])
    expect(items).toHaveLength(0)
  })

  it('returns empty items when gh returns non-array JSON', () => {
    mockExec.mockReturnValueOnce(JSON.stringify({ error: 'rate limited' }))

    const items = scraper.scrapeGitHubTrending(['test'])
    expect(items).toHaveLength(0)
  })

  // ── Retry logic ─────────────────────────────────────────────────

  it('retries on ETIMEDOUT up to 3 attempts', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('ETIMEDOUT') })
      .mockImplementationOnce(() => { throw new Error('ETIMEDOUT') })
      .mockReturnValueOnce(JSON.stringify(makeRepos([5])))

    const items = scraper.scrapeGitHubTrending(['retry'])
    expect(items).toHaveLength(1)
    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('retries on ECONNRESET', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('ECONNRESET') })
      .mockReturnValueOnce(JSON.stringify(makeRepos([10])))

    const items = scraper.scrapeGitHubTrending(['retry'])
    expect(items).toHaveLength(1)
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('retries on socket hang up', () => {
    mockExec
      .mockImplementationOnce(() => { throw new Error('socket hang up') })
      .mockReturnValueOnce('[]')

    scraper.scrapeGitHubTrending(['retry'])
    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('throws after 3 attempts on persistent network error', () => {
    mockExec.mockImplementation(() => { throw new Error('ETIMEDOUT') })

    expect(() => scraper.scrapeGitHubTrending(['fail'])).toThrow('ETIMEDOUT')
    expect(mockExec).toHaveBeenCalledTimes(3)
  })

  it('does not retry on non-network errors', () => {
    mockExec.mockImplementation(() => { throw new Error('gh: command not found') })

    expect(() => scraper.scrapeGitHubTrending(['x'])).toThrow('gh: command not found')
    expect(mockExec).toHaveBeenCalledTimes(1)
  })

  // ── scrapeAIPapers ──────────────────────────────────────────────

  it('scrapeAIPapers uses keyword search instead of --topic', () => {
    mockExec.mockReturnValueOnce(JSON.stringify(makeRepos([50])))

    const items = scraper.scrapeAIPapers(['llm'])

    expect(items).toHaveLength(1)
    expect(items[0].summary).toContain('Paper repo:')
    expect(items[0].landing_suggestion).toContain('AI research')
    const args = mockExec.mock.calls[0][1] as string[]
    expect(args).toContain('llm paper')
    expect(args).not.toContain('--topic=llm')
  })

  // ── FrontierItem shape ──────────────────────────────────────────

  it('populates all FrontierItem fields', () => {
    mockExec.mockReturnValueOnce(JSON.stringify([{
      name: 'cool-repo',
      url: 'https://github.com/cool/repo',
      description: 'A cool project',
      stargazersCount: 500,
    }]))

    const items = scraper.scrapeGitHubTrending(['test'])
    const item = items[0]

    expect(item.name).toBe('cool-repo')
    expect(item.url).toBe('https://github.com/cool/repo')
    expect(item.description).toBe('A cool project')
    expect(item.summary).toContain('cool-repo')
    expect(item.landing_suggestion).toContain('test')
    expect(typeof item.score).toBe('number')
  })

  it('handles missing description gracefully', () => {
    mockExec.mockReturnValueOnce(JSON.stringify([{
      name: 'no-desc', url: 'u', stargazersCount: 10,
    }]))

    const items = scraper.scrapeGitHubTrending(['x'])
    expect(items[0].description).toBe('')
    expect(items[0].summary).toContain('No description')
  })
})
