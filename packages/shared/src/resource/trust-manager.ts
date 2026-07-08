import fs from "fs"
import path from "path"
import yaml from "js-yaml"

/**
 * TrustManager — manages resource_sources.trusted in config.yaml.
 * Allowlist model: remote sources must be explicitly trusted.
 * builtin: and local: are always trusted (no allowlist check needed).
 */
export class TrustManager {
  private configPath: string

  constructor(orgBasePath: string) {
    this.configPath = path.join(orgBasePath, "config.yaml")
  }

  /** Add URL to trusted sources (idempotent) */
  addTrusted(url: string): void {
    const config = this.loadConfig()
    if (!config.resource_sources) {
      config.resource_sources = { trusted: [] }
    }
    if (!config.resource_sources.trusted) {
      config.resource_sources.trusted = []
    }
    if (!config.resource_sources.trusted.includes(url)) {
      config.resource_sources.trusted.push(url)
      this.saveConfig(config)
    }
  }

  /** Remove URL from trusted sources (no-op if missing) */
  removeTrusted(url: string): void {
    const config = this.loadConfig()
    if (!config.resource_sources?.trusted) return
    const idx = config.resource_sources.trusted.indexOf(url)
    if (idx >= 0) {
      config.resource_sources.trusted.splice(idx, 1)
      this.saveConfig(config)
    }
  }

  /** Check if URL is in allowlist */
  isTrusted(url: string): boolean {
    const config = this.loadConfig()
    return config.resource_sources?.trusted?.includes(url) ?? false
  }

  /** List all trusted URLs */
  listTrusted(): string[] {
    const config = this.loadConfig()
    return config.resource_sources?.trusted ?? []
  }

  private loadConfig(): Record<string, any> {
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8")
      return (yaml.load(raw) as Record<string, any>) ?? {}
    } catch {
      return {}
    }
  }

  private saveConfig(config: Record<string, any>): void {
    const dir = path.dirname(this.configPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const tmpPath = this.configPath + ".tmp"
    fs.writeFileSync(tmpPath, yaml.dump(config), "utf-8")
    fs.renameSync(tmpPath, this.configPath)
  }
}
