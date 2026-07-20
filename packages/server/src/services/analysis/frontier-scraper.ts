import { execFileSync } from 'child_process'

// ── Types ──────────────────────────────────────────────────────────

export interface FrontierItem {
  name: string
  url: string
  description: string
  score: number
  summary: string
  landing_suggestion: string
}

interface GhRepoResult {
  name: string
  url: string
  description: string
  stargazersCount: number
}

// ── Helpers ────────────────────────────────────────────────────────

function execGh(args: string[], attempt = 1, maxAttempts = 3): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf-8', timeout: 30_000 })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    // Network-ish errors are retryable
    if (
      /ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|socket hang up/i.test(msg) &&
      attempt < maxAttempts
    ) {
      return execGh(args, attempt + 1, maxAttempts)
    }
    throw err
  }
}

function normalizeScore(stars: number, maxStars: number): number {
  if (maxStars <= 0) return 0
  return Math.min(100, Math.round((stars / maxStars) * 100))
}

function parseJsonSafe(raw: string): GhRepoResult[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── FrontierScraper ────────────────────────────────────────────────

export class FrontierScraper {
  /**
   * Search GitHub trending repos for each domain via `gh` CLI.
   * Returns aggregated FrontierItems sorted by normalized stargazers.
   */
  scrapeGitHubTrending(domains: string[]): FrontierItem[] {
    const allItems: FrontierItem[] = []

    for (const domain of domains) {
      const raw = execGh([
        'search', 'repos',
        `--topic=${domain}`,
        '--sort=stars',
        '--limit=10',
        '--json=name,url,description,stargazersCount',
      ])

      const repos = parseJsonSafe(raw)
      const maxStars = repos.reduce((m, r) => Math.max(m, r.stargazersCount), 0)

      for (const r of repos) {
        allItems.push({
          name: r.name,
          url: r.url,
          description: r.description ?? '',
          score: normalizeScore(r.stargazersCount, maxStars),
          summary: `${r.name}: ${r.description ?? 'No description'}`,
          landing_suggestion: `Explore ${r.name} for ${domain} domain insights`,
        })
      }
    }

    return allItems
  }

  /**
   * Search AI papers via GitHub repos with topic "paper" + domain keyword.
   * ponytail: real paper APIs (arxiv/semantic scholar) need HTTP deps —
   * gh search covers the same shape with zero new dependencies.
   */
  scrapeAIPapers(domains: string[]): FrontierItem[] {
    const allItems: FrontierItem[] = []

    for (const domain of domains) {
      const raw = execGh([
        'search', 'repos',
        `${domain} paper`,
        '--sort=stars',
        '--limit=10',
        '--json=name,url,description,stargazersCount',
      ])

      const repos = parseJsonSafe(raw)
      const maxStars = repos.reduce((m, r) => Math.max(m, r.stargazersCount), 0)

      for (const r of repos) {
        allItems.push({
          name: r.name,
          url: r.url,
          description: r.description ?? '',
          score: normalizeScore(r.stargazersCount, maxStars),
          summary: `Paper repo: ${r.name} — ${r.description ?? 'No description'}`,
          landing_suggestion: `Review ${r.name} for ${domain} AI research`,
        })
      }
    }

    return allItems
  }
}
