import fs from 'fs'
import path from 'path'
import os from 'os'
import yaml from 'js-yaml'
import { agentConfigSchema, type AgentConfigYaml } from './config-schema'
import { getAgentConfigPath } from './paths'

export interface ConfigLoadResult {
  config: AgentConfigYaml
  degraded: boolean
  warnings: string[]
}

export class ConfigManager {
  private cache = new Map<string, ConfigLoadResult>()

  /**
   * Load and validate config.yaml for an org.
   * If the file doesn't exist or is corrupt, returns defaults with degraded=true.
   * Individual invalid fields fall back to defaults with a warning.
   */
  loadConfig(org: string): ConfigLoadResult {
    const cached = this.cache.get(org)
    if (cached) return cached

    const configPath = this.getConfigPath(org)
    const warnings: string[] = []

    if (!fs.existsSync(configPath)) {
      const result: ConfigLoadResult = {
        config: agentConfigSchema.parse({}),
        degraded: true,
        warnings: [`Config file not found: ${configPath}, using defaults`],
      }
      this.cache.set(org, result)
      return result
    }

    let rawContent: string
    try {
      rawContent = fs.readFileSync(configPath, 'utf-8')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const result: ConfigLoadResult = {
        config: agentConfigSchema.parse({}),
        degraded: true,
        warnings: [`Failed to read config: ${msg}`],
      }
      this.cache.set(org, result)
      return result
    }

    let parsed: unknown
    try {
      parsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const result: ConfigLoadResult = {
        config: agentConfigSchema.parse({}),
        degraded: true,
        warnings: [`YAML parse error: ${msg}, using defaults`],
      }
      this.cache.set(org, result)
      return result
    }

    // Validate with Zod — partial results for per-field degradation
    const zodResult = agentConfigSchema.safeParse(parsed ?? {})
    if (zodResult.success) {
      // Check default_org directory exists
      const config = zodResult.data
      if (config.default_org) {
        const orgDir = path.join(os.homedir(), '.octopus', 'orgs', config.default_org)
        if (!fs.existsSync(orgDir)) {
          warnings.push(`default_org '${config.default_org}' directory does not exist, clearing`)
          config.default_org = ''
        }
      }

      const result: ConfigLoadResult = {
        config,
        degraded: false,
        warnings,
      }
      this.cache.set(org, result)
      return result
    }

    // Partial degradation: use defaults but report each validation error
    for (const issue of zodResult.error.issues) {
      warnings.push(`Field '${issue.path.join('.')}': ${issue.message}, using default`)
    }

    const result: ConfigLoadResult = {
      config: agentConfigSchema.parse({}),
      degraded: true,
      warnings,
    }
    this.cache.set(org, result)
    return result
  }

  /**
   * Get config for an org (cached).
   */
  getConfig(org: string): AgentConfigYaml {
    return this.loadConfig(org).config
  }

  /**
   * Update config fields and write back to config.yaml.
   */
  updateConfig(org: string, partial: Partial<AgentConfigYaml>): ConfigLoadResult {
    const current = this.getConfig(org)
    const merged = { ...current, ...partial }

    // Validate merged config
    const zodResult = agentConfigSchema.safeParse(merged)
    if (!zodResult.success) {
      const errors = zodResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')
      throw new Error(`Invalid config update: ${errors}`)
    }

    // Write back to file
    const configPath = this.getConfigPath(org)
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const yamlContent = yaml.dump(zodResult.data, { indent: 2, lineWidth: 120 })
    fs.writeFileSync(configPath, yamlContent, 'utf-8')

    // Invalidate cache
    this.cache.delete(org)
    return this.loadConfig(org)
  }

  /**
   * Check if config is in degraded state.
   */
  isDegraded(org: string): boolean {
    return this.loadConfig(org).degraded
  }

  /**
   * Clear the config cache for an org (or all orgs).
   */
  clearCache(org?: string): void {
    if (org) {
      this.cache.delete(org)
    } else {
      this.cache.clear()
    }
  }

  private getConfigPath(_org?: string): string {
    return getAgentConfigPath()
  }
}

// Singleton
let configManagerInstance: ConfigManager | null = null

export function getConfigManager(): ConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManager()
  }
  return configManagerInstance
}
