import { getDbPath } from '../../db/connection'
import type { SecretMasker } from './secret-masker'

// ponytail: hardcoded env prefix whitelist — covers all Octopus-relevant prefixes

const ENV_WHITELIST_PREFIXES = [
  'NODE_', 'OCTOPUS_', 'NEXT_', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_',
  'DATABASE_', 'REDIS_', 'POSTGRES_', 'LOG_',
]
const ENV_WHITELIST_EXACT = ['PORT', 'DEBUG', 'VERBOSE']

const SYSTEM_VARS = new Set(['HOME', 'SHELL', 'SSH_AUTH_SOCK', 'USER', 'TERM', 'TERM_PROGRAM', 'LANG', 'LC_ALL'])

export interface ConfigResponse {
  server: {
    port: number
    mode: string
    branch: string | null
    db_path: string
  }
  environment: Record<string, string>
  agent: {
    model: string
    timeout: number
    max_clones: number
    safe_mode: boolean
    onboarding_completed: boolean
    default_org: string
  }
  features: {
    scheduler_enabled: boolean
    observability_enabled: boolean
  }
}

export class ConfigResolver {
  constructor(private secretMasker: SecretMasker) {}

  getConfig(): ConfigResponse {
    const branch = process.env.OCTOPUS_BRANCH ?? null
    const port = parseInt(process.env.PORT ?? '3001', 10)

    return {
      server: {
        port,
        mode: branch ? 'isolated' : 'default',
        branch,
        db_path: getDbPath(),
      },
      environment: this.filterAndMaskEnv(),
      agent: this.getAgentConfig(),
      features: {
        scheduler_enabled: process.env.OCTOPUS_SCHEDULER_DISABLED !== 'true',
        observability_enabled: true,
      },
    }
  }

  private filterAndMaskEnv(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (SYSTEM_VARS.has(key)) continue
      if (!this.isWhitelisted(key)) continue
      result[key] = this.secretMasker.maskValue(key, value)
    }
    return result
  }

  private isWhitelisted(key: string): boolean {
    if (ENV_WHITELIST_EXACT.includes(key)) return true
    return ENV_WHITELIST_PREFIXES.some(prefix => key.startsWith(prefix))
  }

  private getAgentConfig(): ConfigResponse['agent'] {
    // ponytail: read from config manager if available, fallback to defaults
    try {
      const { getConfigManager } = require('../agent/config-manager')
      const config = getConfigManager().getConfig('default')
      return {
        model: config.model ?? 'claude-sonnet-4-20250514',
        timeout: config.timeout ?? 300,
        max_clones: config.max_clones ?? 5,
        safe_mode: config.safe_mode?.enabled ?? false,
        onboarding_completed: config.onboarding_completed ?? false,
        default_org: config.default_org ?? 'default',
      }
    } catch {
      return {
        model: 'claude-sonnet-4-20250514',
        timeout: 300,
        max_clones: 5,
        safe_mode: false,
        onboarding_completed: false,
        default_org: 'default',
      }
    }
  }
}
