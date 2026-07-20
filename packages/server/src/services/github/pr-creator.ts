import { execFileSync } from 'child_process'

// ── Types ──────────────────────────────────────────────────────────

export interface CreatePROptions {
  repo: string
  branch: string
  title: string
  body: string
  files: { path: string; content: string }[]
  org?: string
  baseBranch?: string
}

export interface PRResult {
  prUrl: string
  prNumber: number
}

// ── Sensitive-info filter ──────────────────────────────────────────

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /(?:token|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
  /(?:ghp_|gho_|ghu_|ghs_|ghr_)\w{36,}/g,          // GitHub PATs
  /(?:sk-)[a-zA-Z0-9]{20,}/g,                         // OpenAI-style keys
  /AKIA[0-9A-Z]{16}/g,                                // AWS access keys
]

export function maskSensitiveInfo(text: string): string {
  let result = text
  for (const re of SENSITIVE_PATTERNS) {
    result = result.replace(re, match => {
      if (match.length <= 8) return '[REDACTED]'
      return match.slice(0, 4) + '[REDACTED]' + match.slice(-4)
    })
  }
  return result
}

// ── Retry helper ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function withRetry<T>(fn: () => T, attempts = 3, baseMs = 1000): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(baseMs * Math.pow(2, i))
    }
  }
  throw lastErr
}

// ── PR Creator ─────────────────────────────────────────────────────

/**
 * Creates a GitHub Pull Request by shelling out to the `gh` CLI.
 * Simpler than adding @octokit/rest — no new dependency.
 */
export class GitHubPRCreator {
  /**
   * Create a PR: writes files to a temp branch, commits, pushes, and opens the PR.
   * Uses execFileSync with argument arrays — no shell interpolation = no command injection.
   */
  async createPR(options: CreatePROptions): Promise<PRResult> {
    const { repo, branch, title, body, files, baseBranch = 'main' } = options
    const safeBody = maskSensitiveInfo(body)
    const safeTitle = maskSensitiveInfo(title)

    return withRetry(async () => {
      // Write files to disk
      for (const f of files) {
        const dir = require('path').dirname(f.path)
        require('fs').mkdirSync(require('path').join(repo, dir), { recursive: true })
        require('fs').writeFileSync(require('path').join(repo, f.path), f.content, 'utf-8')
      }

      // Git operations via execFileSync (no shell interpolation)
      execFileSync('git', ['checkout', '-B', branch], { cwd: repo, stdio: 'pipe' })
      execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' })
      execFileSync('git', ['commit', '-m', safeTitle, '--allow-empty'], { cwd: repo, stdio: 'pipe' })
      execFileSync('git', ['push', 'origin', branch, '--force-with-lease'], { cwd: repo, stdio: 'pipe' })

      // Create the PR via gh CLI (argument array, no shell)
      const prOutput = execFileSync('gh', [
        'pr', 'create',
        '--title', safeTitle,
        '--body', safeBody,
        '--base', baseBranch,
        '--head', branch,
      ], { cwd: repo, stdio: 'pipe', encoding: 'utf-8' }).trim()

      const prUrl = prOutput.split('\n').pop() ?? ''
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/)
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0

      return { prUrl, prNumber }
    })
  }
}
