// packages/server/src/services/harness/config-service.ts
//
// HarnessConfigService — load, validate, save, and merge harness configuration.
// The default config ships with @octopus/shared (harness-defaults.yaml).
// User overrides are stored in the harness_config DB table and merged on top.

import { readFileSync, existsSync } from "fs"
import path from "path"
import { load as yamlLoad, dump as yamlDump } from "js-yaml"
import { HarnessSystemConfigSchema } from "@octopus/shared"
import type { HarnessSystemConfigParsed } from "@octopus/shared"
import type { HarnessDAO, HarnessConfigRow } from "../../db/dao/harness-dao"

/**
 * Resolve the path to harness-defaults.yaml shipped with @octopus/shared.
 * Uses multiple strategies since package.json may not be in "exports".
 * Falls back to null if no strategy succeeds.
 */
function resolveDefaultsPath(): string | null {
  const candidates: string[] = []

  // Strategy 1: require.resolve("@octopus/shared/package.json") — needs exports entry
  try {
    const pkgJsonPath = require.resolve("@octopus/shared/package.json")
    candidates.push(path.join(path.dirname(pkgJsonPath), "src/harness/harness-defaults.yaml"))
  } catch { /* exports may not include ./package.json */ }

  // Strategy 2: Navigate from the shared module's main entry
  try {
    const mainEntry = require.resolve("@octopus/shared")
    candidates.push(path.join(path.dirname(mainEntry), "..", "src", "harness", "harness-defaults.yaml"))
  } catch { /* package not resolvable */ }

  // Strategy 3: Monorepo-relative paths from server source / dist
  // Works in dev (tsx: __dirname = packages/server/src/services/harness)
  // and production (tsup: __dirname = packages/server/dist)
  try {
    const dir = __dirname
    candidates.push(path.resolve(dir, "..", "..", "..", "shared", "src", "harness", "harness-defaults.yaml"))
    candidates.push(path.resolve(dir, "..", "..", "..", "..", "packages", "shared", "src", "harness", "harness-defaults.yaml"))
  } catch { /* __dirname not available */ }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * Complete fallback defaults — used when harness-defaults.yaml cannot be resolved.
 * Must stay in sync with packages/shared/src/harness/harness-defaults.yaml.
 */
const MINIMAL_DEFAULTS_YAML = `
detectors:
  stupid_retry:
    enabled: true
    threshold: 2
  model_mismatch:
    enabled: true
  process_conflict:
    enabled: true
  timeout_cascade:
    enabled: true
    threshold: 3
strategies:
  - match: stupid_retry
    actions:
      - type: inject_message
        message: "上次因为同样的原因失败了。请换一种方法解决。"
      - type: retry_with_hint
  - match: model_mismatch
    actions:
      - type: switch_model
        prefer: vision_capable
  - match: process_conflict
    severity: critical
    actions:
      - type: abort
        reason: "检测到进程冲突，已阻断以保护宿主进程"
  - match: timeout_cascade
    actions:
      - type: pause
        notify: true
  - match: "*"
    actions:
      - type: pause_and_notify
    delegate_to_agent: true
isolation:
  process_group: true
  port_protection: true
  pid_protection: true
  sandbox: auto
  fs_whitelist: [".", "/tmp"]
`

export class HarnessConfigService {
  private defaultsYaml: string
  private defaultsParsed: HarnessSystemConfigParsed

  constructor(private dao: HarnessDAO) {
    const defaultsPath = resolveDefaultsPath()
    this.defaultsYaml = defaultsPath
      ? readFileSync(defaultsPath, "utf-8")
      : MINIMAL_DEFAULTS_YAML

    // Parse and validate defaults at construction time (fail-fast)
    const raw = yamlLoad(this.defaultsYaml)
    this.defaultsParsed = HarnessSystemConfigSchema.parse(raw)
  }

  /**
   * Return the raw YAML for the current config.
   * If a DB override exists, return it; otherwise return the shipped defaults.
   */
  getConfig(): { config: string; version: number; source: "db" | "defaults" } {
    const row = this.dao.getConfig()
    if (row) {
      return { config: row.config_yaml, version: row.version, source: "db" }
    }
    return { config: this.defaultsYaml, version: 0, source: "defaults" }
  }

  /**
   * Validate a YAML string against HarnessSystemConfigSchema,
   * then persist it to the DB with a version bump.
   * Returns the new version number.
   * Throws if the YAML is invalid.
   */
  saveConfig(yamlContent: string): { success: true; version: number } {
    // Parse YAML
    const raw = yamlLoad(yamlContent)
    if (typeof raw !== "object" || raw === null) {
      throw new HarnessConfigError("Config must be a YAML object", 400)
    }

    // Validate with Zod
    const parsed = HarnessSystemConfigSchema.parse(raw)

    // Re-dump to normalize the YAML (removes comments, ensures consistent format)
    const normalized = yamlDump(parsed, { lineWidth: 120 })

    const row = this.dao.saveConfig(normalized)
    return { success: true, version: row.version }
  }

  /**
   * Load the merged configuration: defaults overlaid with DB overrides.
   * Only detector/strategy entries present in the DB override replace defaults;
   * missing entries fall through to defaults.
   */
  loadMergedConfig(): HarnessSystemConfigParsed {
    const row = this.dao.getConfig()
    if (!row) return this.defaultsParsed

    try {
      const userRaw = yamlLoad(row.config_yaml)
      const userParsed = HarnessSystemConfigSchema.parse(userRaw)

      // Merge: user overrides take precedence; defaults fill gaps.
      return {
        detectors: { ...this.defaultsParsed.detectors, ...userParsed.detectors },
        strategies: userParsed.strategies.length > 0
          ? userParsed.strategies
          : this.defaultsParsed.strategies,
        isolation: userParsed.isolation
          ? { ...this.defaultsParsed.isolation, ...userParsed.isolation }
          : this.defaultsParsed.isolation,
      }
    } catch {
      // If DB config is invalid, fall back to defaults
      return this.defaultsParsed
    }
  }

  /**
   * Return the shipped defaults (parsed).
   */
  getDefaults(): HarnessSystemConfigParsed {
    return this.defaultsParsed
  }
}

export class HarnessConfigError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = "HarnessConfigError"
  }
}
