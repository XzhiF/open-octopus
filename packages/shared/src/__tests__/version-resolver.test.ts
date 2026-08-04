import { describe, it, expect } from "vitest"
import { VersionResolver, VersionNotFoundError } from "../version/version-resolver"
import type { AgentVersionInfo } from "../types/octopus-agent"

// Helper to create test version records
function makeVersion(overrides: Partial<AgentVersionInfo>): AgentVersionInfo {
  return {
    id: "test-id",
    agent_name: "workspace",
    version: "1.0.0",
    stage: "stable",
    status: "published",
    snapshot: '{"persona":"test","config":{},"skills":[]}',
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

describe("VersionResolver", () => {
  describe("resolve with pinned version", () => {
    it("resolves an exact version match", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "published" }),
        makeVersion({ version: "1.1.0", stage: "stable", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "1.0.0")
      expect(result.version).toBe("1.0.0")
      expect(result.stage).toBe("stable")
    })

    it("resolves an exact version match with stage qualifier", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0-beta.1", stage: "beta", status: "published" }),
        makeVersion({ version: "1.0.0", stage: "stable", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "1.0.0-beta.1")
      expect(result.version).toBe("1.0.0-beta.1")
      expect(result.stage).toBe("beta")
    })

    it("resolves pinned version even if archived", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "archived" }),
        makeVersion({ version: "2.0.0", stage: "stable", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "1.0.0")
      expect(result.version).toBe("1.0.0")
    })

    it("throws VersionNotFoundError for non-existent version", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      expect(() => resolver.resolve("workspace", "9.9.9")).toThrow(VersionNotFoundError)
    })
  })

  describe("resolve with 'latest'", () => {
    it("resolves to latest published stable version", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "published", published_at: "2026-01-01T00:00:00Z" }),
        makeVersion({ version: "2.0.0", stage: "stable", status: "published", published_at: "2026-06-01T00:00:00Z" }),
        makeVersion({ version: "3.0.0-alpha.1", stage: "alpha", status: "published", published_at: "2026-07-01T00:00:00Z" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest")
      expect(result.version).toBe("2.0.0")
    })

    it("skips draft versions when resolving latest", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "published", published_at: "2026-01-01T00:00:00Z" }),
        makeVersion({ version: "2.0.0", stage: "stable", status: "draft" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest")
      expect(result.version).toBe("1.0.0")
    })

    it("skips archived versions when resolving latest", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "published", published_at: "2026-01-01T00:00:00Z" }),
        makeVersion({ version: "2.0.0", stage: "stable", status: "archived" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest")
      expect(result.version).toBe("1.0.0")
    })

    it("throws when no published versions exist", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0", stage: "stable", status: "draft" }),
      ]
      const resolver = new VersionResolver(versions)
      expect(() => resolver.resolve("workspace", "latest")).toThrow(VersionNotFoundError)
    })
  })

  describe("resolve with min_stage", () => {
    it("resolves latest version that meets min_stage requirement", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0-alpha.1", stage: "alpha", status: "published", published_at: "2026-01-01T00:00:00Z" }),
        makeVersion({ version: "1.0.0-beta.1", stage: "beta", status: "published", published_at: "2026-02-01T00:00:00Z" }),
        makeVersion({ version: "1.0.0-rc.1", stage: "rc", status: "published", published_at: "2026-03-01T00:00:00Z" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest", "beta")
      expect(result.version).toBe("1.0.0-rc.1")
    })

    it("falls back to highest version meeting min_stage when no stable exists", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0-alpha.1", stage: "alpha", status: "published", published_at: "2026-01-01T00:00:00Z" }),
        makeVersion({ version: "1.0.0-beta.1", stage: "beta", status: "published", published_at: "2026-02-01T00:00:00Z" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest", "alpha")
      expect(result.version).toBe("1.0.0-beta.1")
    })

    it("throws when no versions meet min_stage requirement", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ version: "1.0.0-alpha.1", stage: "alpha", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      expect(() => resolver.resolve("workspace", "latest", "stable")).toThrow(VersionNotFoundError)
    })
  })

  describe("resolve with different agent names", () => {
    it("filters versions by agent_name", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ agent_name: "workspace", version: "1.0.0", stage: "stable", status: "published" }),
        makeVersion({ agent_name: "scheduler", version: "2.0.0", stage: "stable", status: "published" }),
      ]
      const resolver = new VersionResolver(versions)
      const result = resolver.resolve("workspace", "latest")
      expect(result.version).toBe("1.0.0")
    })

    it("throws when no versions exist for the given agent_name", () => {
      const versions: AgentVersionInfo[] = [
        makeVersion({ agent_name: "workspace", version: "1.0.0" }),
      ]
      const resolver = new VersionResolver(versions)
      expect(() => resolver.resolve("nonexistent", "latest")).toThrow(VersionNotFoundError)
    })
  })

  describe("resolve with empty version list", () => {
    it("throws VersionNotFoundError", () => {
      const resolver = new VersionResolver([])
      expect(() => resolver.resolve("workspace", "latest")).toThrow(VersionNotFoundError)
    })
  })
})
