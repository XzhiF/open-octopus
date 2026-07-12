import fs from 'fs'
import path from 'path'
import os from 'os'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'

// ── Types ──────────────────────────────────────────────────────────

export interface SchedulerYamlConfig {
  global?: Record<string, unknown>
  tasks?: Array<Record<string, unknown>>
  evolution_scope?: string[]
  retire_protected?: string[]
}

// ── EvolutionConfigService ─────────────────────────────────────────

export class EvolutionConfigService {
  private baseDir: string

  /** Override baseDir for testing (defaults to OCTOPUS_HOME or ~/.octopus) */
  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus')
  }

  private configPath(org: string): string {
    return path.join(this.baseDir, 'orgs', org, 'config', 'scheduler.yaml')
  }

  private readConfig(org: string): SchedulerYamlConfig {
    const p = this.configPath(org)
    if (!fs.existsSync(p)) return {}
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = yamlLoad(raw)
    if (parsed && typeof parsed === 'object') return parsed as SchedulerYamlConfig
    return {}
  }

  private writeConfig(org: string, config: SchedulerYamlConfig): void {
    const p = this.configPath(org)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, yamlDump(config, { lineWidth: 120 }), 'utf-8')
  }

  // ── Evolution Scope ────────────────────────────────────────────

  getEvolutionScope(org: string): string[] {
    return this.readConfig(org).evolution_scope ?? []
  }

  updateEvolutionScope(org: string, scopes: string[]): void {
    const config = this.readConfig(org)
    config.evolution_scope = scopes
    this.writeConfig(org, config)
  }

  // ── Retire Protected ───────────────────────────────────────────

  getRetireProtected(org: string): string[] {
    return this.readConfig(org).retire_protected ?? []
  }

  updateRetireProtected(org: string, items: string[]): void {
    const config = this.readConfig(org)
    config.retire_protected = items
    this.writeConfig(org, config)
  }
}
