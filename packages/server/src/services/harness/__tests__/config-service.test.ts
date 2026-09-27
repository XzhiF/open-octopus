// P1 B1: HarnessDAO/HarnessConfigService 已 postgres.js/async —— :memory: fixture 切
// PG 随机测试库（README 快路径）；用例语义与条数不变（toThrow → rejects.toThrow 同判据）。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { HarnessDAO } from "../../../db/dao/harness-dao"
import { HarnessConfigService, HarnessConfigError } from "../config-service"
import { describePg, setupPgSchema, type PgFixture } from "../../../db/pg/__tests__/dao-fixture"

let pg: PgFixture
let dao: HarnessDAO
let service: HarnessConfigService

beforeEach(async () => {
  pg = await setupPgSchema()
  dao = new HarnessDAO(pg.sql)
  service = new HarnessConfigService(dao)
})

afterEach(async () => {
  await pg.close()
})

describePg("HarnessConfigService", () => {
  describe("getConfig", () => {
    it("returns defaults when no DB config exists", async () => {
      const result = await service.getConfig()
      expect(result.source).toBe("defaults")
      expect(result.version).toBe(0)
      expect(result.config).toContain("detectors")
      expect(result.config).toContain("stupid_retry")
    })

    it("returns DB config when saved", async () => {
      const yaml = "detectors:\n  stupid_retry:\n    enabled: false\n"
      await service.saveConfig(yaml)
      const result = await service.getConfig()
      expect(result.source).toBe("db")
      expect(result.version).toBe(1)
      // The saved config is normalized by yamlDump
      expect(result.config).toContain("stupid_retry")
    })
  })

  describe("saveConfig", () => {
    it("saves valid YAML and returns version", async () => {
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
      const result = await service.saveConfig(yaml)
      expect(result.success).toBe(true)
      expect(result.version).toBe(1)
    })

    it("bumps version on subsequent saves", async () => {
      const yaml1 = "detectors:\n  stupid_retry:\n    enabled: true\n"
      const yaml2 = "detectors:\n  stupid_retry:\n    enabled: false\n"

      const r1 = await service.saveConfig(yaml1)
      expect(r1.version).toBe(1)

      const r2 = await service.saveConfig(yaml2)
      expect(r2.version).toBe(2)
    })

    it("throws on invalid YAML (non-object)", async () => {
      await expect(service.saveConfig("just a string")).rejects.toThrow(HarnessConfigError)
    })

    it("throws on YAML that fails Zod validation", async () => {
      const invalidYaml = `
detectors:
  stupid_retry:
    enabled: "not_a_boolean"
`
      await expect(service.saveConfig(invalidYaml)).rejects.toThrow()
    })

    it("normalizes YAML on save (removes extra fields)", async () => {
      const yaml = `
detectors:
  stupid_retry:
    enabled: true
strategies: []
extra_unknown_field: "should be stripped"
`
      await service.saveConfig(yaml)
      const result = await service.getConfig()
      // The normalized output should not contain unknown top-level fields
      // (Zod strips them by default for .object schemas)
      expect(result.config).not.toContain("extra_unknown_field")
    })
  })

  describe("loadMergedConfig", () => {
    it("returns defaults when no DB config", async () => {
      const merged = await service.loadMergedConfig()
      expect(merged.detectors).toBeDefined()
      expect(merged.detectors.stupid_retry).toBeDefined()
      expect(merged.detectors.stupid_retry.enabled).toBe(true)
    })

    it("merges DB overrides on top of defaults", async () => {
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
      await service.saveConfig(yaml)
      const merged = await service.loadMergedConfig()

      // DB override takes effect
      expect(merged.detectors.stupid_retry.enabled).toBe(false)
      expect(merged.detectors.stupid_retry.threshold).toBe(5)

      // Other detectors from defaults still present
      expect(merged.detectors.model_mismatch).toBeDefined()

      // Strategies from DB replace defaults
      expect(merged.strategies).toHaveLength(1)
      expect(merged.strategies[0].match).toBe("stupid_retry")
    })

    it("falls back to defaults if DB config is invalid", async () => {
      // Directly insert invalid YAML to bypass saveConfig validation
      await dao.saveConfig("detectors: not_a_valid_object")
      const merged = await service.loadMergedConfig()
      // Should fall back to defaults
      expect(merged.detectors.stupid_retry).toBeDefined()
    })
  })

  describe("getDefaults", () => {
    it("returns parsed default configuration", async () => {
      const defaults = service.getDefaults()
      expect(defaults.detectors).toBeDefined()
      expect(defaults.strategies).toBeInstanceOf(Array)
      expect(defaults.detectors.stupid_retry.enabled).toBe(true)
      expect(defaults.detectors.stupid_retry.threshold).toBe(2)
    })
  })
})
