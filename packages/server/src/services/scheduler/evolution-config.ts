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

// Optional DAO interface for DB-backed config storage.
interface EvolutionConfigDAO {
  findOrgConfig(org: string, name: string): { config: string } | null
  upsertOrgConfig(org: string, name: string, config: string): void
}

// ── EvolutionConfigService ─────────────────────────────────────────

export class EvolutionConfigService {
  private baseDir: string
  private dao: EvolutionConfigDAO | null

  /**
   * @param dao Optional DAO for DB-backed config (org-isolated via DB rows).
   *            When provided, config is stored in the schedules table instead of filesystem.
   *            When null, falls back to filesystem YAML for backward compatibility.
   */
  constructor(baseDir?: string, dao?: EvolutionConfigDAO) {
    this.baseDir = baseDir ?? process.env.OCTOPUS_HOME ?? path.join(os.homedir(), '.octopus')
    this.dao = dao ?? null
  }

  private configName = '__evolution_config'

  // ── DB-backed read/write ────────────────────────────────────────

  private readConfigDB(org: string): SchedulerYamlConfig | null {
    if (!this.dao) return null
    const row = this.dao.findOrgConfig(org, this.configName)
    if (!row) return null
    try {
      return JSON.parse(row.config) as SchedulerYamlConfig
    } catch {
      return null
    }
  }

  private writeConfigDB(org: string, config: SchedulerYamlConfig): boolean {
    if (!this.dao) return false
    this.dao.upsertOrgConfig(org, this.configName, JSON.stringify(config))
    return true
  }

  // ── Filesystem read/write (fallback) ─────────────────────────────

  private configPath(org: string): string {
    return path.join(this.baseDir, 'orgs', org, 'config', 'scheduler.yaml')
  }

  private readConfigFile(org: string): SchedulerYamlConfig {
    const p = this.configPath(org)
    if (!fs.existsSync(p)) return {}
    const raw = fs.readFileSync(p, 'utf-8')
    const parsed = yamlLoad(raw)
    if (parsed && typeof parsed === 'object') return parsed as SchedulerYamlConfig
    return {}
  }

  private writeConfigFile(org: string, config: SchedulerYamlConfig): void {
    const p = this.configPath(org)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, yamlDump(config, { lineWidth: 120 }), 'utf-8')
  }

  // ── Unified read/write (DB first, filesystem fallback) ─────────

  private readConfig(org: string): SchedulerYamlConfig {
    const dbConfig = this.readConfigDB(org)
    if (dbConfig) return dbConfig
    return this.readConfigFile(org)
  }

  private writeConfig(org: string, config: SchedulerYamlConfig): void {
    const wroteToDb = this.writeConfigDB(org, config)
    if (!wroteToDb) {
      this.writeConfigFile(org, config)
    }
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
