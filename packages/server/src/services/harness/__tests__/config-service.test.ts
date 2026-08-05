import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { HarnessDAO } from "../../../db/dao/harness-dao"
import { HarnessConfigService, HarnessConfigError } from "../config-service"

let db: Database.Database
let dao: HarnessDAO
let service: HarnessConfigService
let dbPath: string

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `test-harness-config-${Date.now()}.db`)
  db = new Database(dbPath)
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new HarnessDAO(db)
  service = new HarnessConfigService(dao)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
})

describe("HarnessConfigService", () => {
  describe("getConfig", () => {
    it("returns defaults when no DB config exists", () => {
      const result = service.getConfig()
      expect(result.source).toBe("defaults")
      expect(result.version).toBe(0)
      expect(result.config).toContain("detectors")
      expect(result.config).toContain("stupid_retry")
    })

    it("returns DB config when saved", () => {
      const yaml = "detectors:\n  stupid_retry:\n    enabled: false\n"
      service.saveConfig(yaml)
      const result = service.getConfig()
      expect(result.source).toBe("db")
      expect(result.version).toBe(1)
      // The saved config is normalized by yamlDump
      expect(result.config).toContain("stupid_retry")
    })
  })

  describe("saveConfig", () => {
    it("saves valid YAML and returns version", () => {
      const yaml = `
detectors:
  stupid_retry:
    enabled: true
    threshold: 3
strategies:
  - match: stupid_retry
    actions:
      - type: inject_message
        message: "Try a different approach"
`
      const result = service.saveConfig(yaml)
      expect(result.success).toBe(true)
      expect(result.version).toBe(1)
    })

    it("bumps version on subsequent saves", () => {
      const yaml1 = "detectors:\n  stupid_retry:\n    enabled: true\n"
      const yaml2 = "detectors:\n  stupid_retry:\n    enabled: false\n"

      const r1 = service.saveConfig(yaml1)
      expect(r1.version).toBe(1)

      const r2 = service.saveConfig(yaml2)
      expect(r2.version).toBe(2)
    })

    it("throws on invalid YAML (non-object)", () => {
      expect(() => service.saveConfig("just a string")).toThrow(HarnessConfigError)
    })

    it("throws on YAML that fails Zod validation", () => {
      const invalidYaml = `
detectors:
  stupid_retry:
    enabled: "not_a_boolean"
`
      expect(() => service.saveConfig(invalidYaml)).toThrow()
    })

    it("normalizes YAML on save (removes extra fields)", () => {
      const yaml = `
detectors:
  stupid_retry:
    enabled: true
strategies: []
extra_unknown_field: "should be stripped"
`
      service.saveConfig(yaml)
      const result = service.getConfig()
      // The normalized output should not contain unknown top-level fields
      // (Zod strips them by default for .object schemas)
      expect(result.config).not.toContain("extra_unknown_field")
    })
  })

  describe("loadMergedConfig", () => {
    it("returns defaults when no DB config", () => {
      const merged = service.loadMergedConfig()
      expect(merged.detectors).toBeDefined()
      expect(merged.detectors.stupid_retry).toBeDefined()
      expect(merged.detectors.stupid_retry.enabled).toBe(true)
    })

    it("merges DB overrides on top of defaults", () => {
      const yaml = `
detectors:
  stupid_retry:
    enabled: false
    threshold: 5
strategies:
  - match: stupid_retry
    actions:
      - type: abort
        reason: "Custom abort reason"
`
      service.saveConfig(yaml)
      const merged = service.loadMergedConfig()

      // DB override takes effect
      expect(merged.detectors.stupid_retry.enabled).toBe(false)
      expect(merged.detectors.stupid_retry.threshold).toBe(5)

      // Other detectors from defaults still present
      expect(merged.detectors.model_mismatch).toBeDefined()

      // Strategies from DB replace defaults
      expect(merged.strategies).toHaveLength(1)
      expect(merged.strategies[0].match).toBe("stupid_retry")
    })

    it("falls back to defaults if DB config is invalid", () => {
      // Directly insert invalid YAML to bypass saveConfig validation
      dao.saveConfig("detectors: not_a_valid_object")
      const merged = service.loadMergedConfig()
      // Should fall back to defaults
      expect(merged.detectors.stupid_retry).toBeDefined()
    })
  })

  describe("getDefaults", () => {
    it("returns parsed default configuration", () => {
      const defaults = service.getDefaults()
      expect(defaults.detectors).toBeDefined()
      expect(defaults.strategies).toBeInstanceOf(Array)
      expect(defaults.detectors.stupid_retry.enabled).toBe(true)
      expect(defaults.detectors.stupid_retry.threshold).toBe(2)
    })
  })
})
