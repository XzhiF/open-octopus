import { describe, it, expect } from "vitest"
import { HarnessSystemConfigSchema } from "../config-schema"
import yaml from "js-yaml"
import fs from "fs"
import path from "path"

describe("HarnessSystemConfigSchema", () => {
  it("validates the default harness-defaults.yaml", () => {
    const defaultsPath = path.join(__dirname, "../harness-defaults.yaml")
    const content = fs.readFileSync(defaultsPath, "utf-8")
    const parsed = yaml.load(content)

    const result = HarnessSystemConfigSchema.safeParse(parsed)

    expect(result.success).toBe(true)
    if (!result.success) {
      console.error("Validation errors:", result.error.issues)
    }
  })

  it("validates a minimal config with only detectors", () => {
    const config = {
      detectors: {
        stupid_retry: {
          enabled: true,
          threshold: 2,
        },
      },
    }

    const result = HarnessSystemConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  it("validates a config with strategies", () => {
    const config = {
      detectors: {
        stupid_retry: {
          enabled: true,
        },
      },
      strategies: [
        {
          match: "stupid_retry",
          actions: [
            {
              type: "inject_message",
              message: "Try a different approach",
            },
          ],
        },
      ],
    }

    const result = HarnessSystemConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  it("validates a config with isolation settings", () => {
    const config = {
      detectors: {},
      isolation: {
        process_group: true,
        port_protection: true,
        sandbox: "auto",
      },
    }

    const result = HarnessSystemConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  it("rejects invalid detector config", () => {
    const config = {
      detectors: {
        stupid_retry: {
          enabled: "yes", // should be boolean
        },
      },
    }

    const result = HarnessSystemConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  it("allows strategy with empty actions array", () => {
    const config = {
      detectors: {},
      strategies: [
        {
          match: "test",
          actions: [],
        },
      ],
    }

    const result = HarnessSystemConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })
})
