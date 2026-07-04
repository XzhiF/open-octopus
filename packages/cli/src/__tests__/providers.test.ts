import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  SourceProviderRegistry,
  LocalProvider,
  BuiltinProvider,
} from "../repository/providers"
import type { SourceRef } from "@octopus/shared"

const baseTmpDir = mkdtempSync(join(tmpdir(), "octopus-providers-test-"))

describe("SourceProviderRegistry", () => {
  it("has all 4 protocols registered by default", () => {
    const registry = new SourceProviderRegistry()
    // Should not throw for any supported protocol
    expect(registry.get({ protocol: "local", path: "/tmp" })).toBeDefined()
    expect(registry.get({ protocol: "npm", package: "x" })).toBeDefined()
    expect(registry.get({ protocol: "github", repo: "a/b" })).toBeDefined()
    expect(registry.get({ protocol: "builtin", id: "x" })).toBeDefined()
  })

  it("throws for unknown protocol", () => {
    const registry = new SourceProviderRegistry()
    expect(() => registry.get({ protocol: "ftp" } as unknown as SourceRef)).toThrow(
      /No provider for protocol/
    )
  })
})

describe("LocalProvider", () => {
  let testDir: string
  const provider = new LocalProvider()

  beforeEach(() => {
    testDir = mkdtempSync(join(baseTmpDir, "local-"))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it("validates existing path", async () => {
    const result = await provider.validate({ protocol: "local", path: testDir })
    expect(result.valid).toBe(true)
  })

  it("rejects non-existing path", async () => {
    const result = await provider.validate({ protocol: "local", path: "/nonexistent/path" })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("not found")
  })

  it("rejects wrong protocol", async () => {
    const result = await provider.validate({ protocol: "npm", package: "x" } as SourceRef)
    expect(result.valid).toBe(false)
  })

  it("fetch() copies directory contents", async () => {
    writeFileSync(join(testDir, "file.txt"), "hello", "utf-8")
    const destDir = mkdtempSync(join(baseTmpDir, "dest-"))
    try {
      const result = await provider.fetch({ protocol: "local", path: testDir }, destDir)
      expect(result.path).toBe(destDir)
      expect(existsSync(join(destDir, "file.txt"))).toBe(true)
      expect(result.version).toBe("0.0.0")
    } finally {
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it("estimateSize() returns size for existing path", async () => {
    writeFileSync(join(testDir, "data.bin"), "x".repeat(100), "utf-8")
    const size = await provider.estimateSize({ protocol: "local", path: testDir })
    expect(size).toBeGreaterThan(0)
  })

  it("estimateSize() returns 0 for non-existing path", async () => {
    const size = await provider.estimateSize({ protocol: "local", path: "/no/such/path" })
    expect(size).toBe(0)
  })
})

describe("BuiltinProvider", () => {
  let mockCorePack: string
  let provider: BuiltinProvider

  beforeEach(() => {
    mockCorePack = mkdtempSync(join(baseTmpDir, "corepack-"))
    mkdirSync(join(mockCorePack, "skills", "my-skill"), { recursive: true })
    writeFileSync(join(mockCorePack, "skills", "my-skill", "SKILL.md"), "# skill", "utf-8")
    mkdirSync(join(mockCorePack, "agents"), { recursive: true })
    writeFileSync(join(mockCorePack, "agents", "my-agent.md"), "# agent", "utf-8")
    provider = new BuiltinProvider(mockCorePack)
  })

  afterEach(() => {
    rmSync(mockCorePack, { recursive: true, force: true })
  })

  it("validates existing builtin skill", async () => {
    const result = await provider.validate({ protocol: "builtin", id: "my-skill" })
    expect(result.valid).toBe(true)
  })

  it("validates existing builtin agent", async () => {
    const result = await provider.validate({ protocol: "builtin", id: "my-agent" })
    expect(result.valid).toBe(true)
  })

  it("rejects non-existing builtin", async () => {
    const result = await provider.validate({ protocol: "builtin", id: "missing" })
    expect(result.valid).toBe(false)
    expect(result.reason).toContain("not found")
  })

  it("rejects wrong protocol", async () => {
    const result = await provider.validate({ protocol: "npm", package: "x" } as SourceRef)
    expect(result.valid).toBe(false)
  })

  it("fetch() copies skill directory", async () => {
    const destDir = mkdtempSync(join(baseTmpDir, "dest-"))
    try {
      const result = await provider.fetch({ protocol: "builtin", id: "my-skill" }, destDir)
      expect(result.path).toBe(destDir)
      expect(result.version).toBe("builtin")
    } finally {
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it("fetch() throws for missing builtin", async () => {
    const destDir = mkdtempSync(join(baseTmpDir, "dest-"))
    try {
      await expect(
        provider.fetch({ protocol: "builtin", id: "missing" }, destDir)
      ).rejects.toThrow(/not found/)
    } finally {
      rmSync(destDir, { recursive: true, force: true })
    }
  })

  it("estimateSize() returns default size", async () => {
    const size = await provider.estimateSize({ protocol: "builtin", id: "x" })
    expect(size).toBe(10_000)
  })
})
