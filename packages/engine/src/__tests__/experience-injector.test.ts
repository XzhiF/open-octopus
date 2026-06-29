// packages/engine/src/__tests__/experience-injector.test.ts
// US-018/US-019: Tests for engine-level experience injection via experience_scope
import { describe, it, expect } from "vitest"
import { ExperienceInjector } from "../executors/experience-injector"
import type { ExperienceQueryPort, ExperienceEntry } from "../executors/experience-injector"

function createMockPort(entries: ExperienceEntry[]): ExperienceQueryPort {
  return {
    findByScope: (scope) => {
      let filtered = [...entries]
      if (scope.types?.length) filtered = filtered.filter(e => scope.types!.includes(e.type as any))
      return filtered.slice(0, scope.limit)
    },
  }
}

describe("ExperienceInjector", () => {
  it("should return empty string when no scope provided", () => {
    const injector = new ExperienceInjector(createMockPort([]))
    expect(injector.inject(undefined)).toBe("")
  })

  it("should return empty string when no query port configured", () => {
    const injector = new ExperienceInjector(undefined)
    expect(injector.inject({ projects: ["server"] })).toBe("")
  })

  it("should inject active experiences into prompt prefix", () => {
    const entries: ExperienceEntry[] = [
      { id: "e1", type: "bug", title: "Memory leak in pool", content: "Connection pool not releasing idle connections after timeout", relevance_score: 0.9, use_count: 5 },
      { id: "e2", type: "pattern", title: "Retry with backoff", content: "Add exponential backoff for API calls to avoid rate limiting", relevance_score: 0.7, use_count: 3 },
    ]
    const injector = new ExperienceInjector(createMockPort(entries))

    const result = injector.inject({ projects: ["server"], types: ["bug", "pattern"], limit: 5 })
    expect(result).toContain("## 相关经验")
    expect(result).toContain("🐛")
    expect(result).toContain("[bug]")
    expect(result).toContain("Memory leak")
    expect(result).toContain("🔧")
    expect(result).toContain("[pattern]")
    expect(result).toContain("Retry")
  })

  it("should return empty string when no matching experiences", () => {
    const injector = new ExperienceInjector(createMockPort([]))
    expect(injector.inject({ projects: ["server"], limit: 5 })).toBe("")
  })

  it("should collect injected IDs for use_count tracking", () => {
    const entries: ExperienceEntry[] = [
      { id: "e1", type: "bug", title: "Bug 1", content: "Content 1" },
      { id: "e2", type: "pattern", title: "Pattern 1", content: "Content 2" },
    ]
    const injector = new ExperienceInjector(createMockPort(entries))

    const ids = injector.getInjectedIds({ projects: ["server"], limit: 5 })
    expect(ids).toEqual(["e1", "e2"])
  })

  it("should return empty IDs when no scope", () => {
    const injector = new ExperienceInjector(createMockPort([]))
    expect(injector.getInjectedIds(undefined)).toEqual([])
  })

  it("should truncate long content in injection", () => {
    const longContent = "x".repeat(500)
    const entries: ExperienceEntry[] = [
      { id: "e1", type: "bug", title: "Long bug", content: longContent },
    ]
    const injector = new ExperienceInjector(createMockPort(entries))

    const result = injector.inject({ limit: 5 })
    // Content should be truncated to 200 chars
    expect(result.length).toBeLessThan(longContent.length)
  })
})
