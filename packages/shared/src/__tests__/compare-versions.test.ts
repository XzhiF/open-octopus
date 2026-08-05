import { describe, it, expect } from "vitest"
import { compareVersions, stageRank, parseVersionString, VersionNotFoundError } from "../version/version-resolver"

describe("stageRank", () => {
  it("returns 0 for alpha", () => {
    expect(stageRank("alpha")).toBe(0)
  })

  it("returns 1 for beta", () => {
    expect(stageRank("beta")).toBe(1)
  })

  it("returns 2 for rc", () => {
    expect(stageRank("rc")).toBe(2)
  })

  it("returns 3 for stable", () => {
    expect(stageRank("stable")).toBe(3)
  })
})

describe("parseVersionString", () => {
  it("parses a simple version without stage", () => {
    const result = parseVersionString("1.2.3")
    expect(result).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      stage: "stable",
      qualifier: undefined,
    })
  })

  it("parses a version with alpha stage", () => {
    const result = parseVersionString("1.0.0-alpha")
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      stage: "alpha",
      qualifier: undefined,
    })
  })

  it("parses a version with beta stage and qualifier", () => {
    const result = parseVersionString("1.0.0-beta.1")
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      stage: "beta",
      qualifier: "1",
    })
  })

  it("parses a version with rc stage and qualifier", () => {
    const result = parseVersionString("2.3.4-rc.2")
    expect(result).toEqual({
      major: 2,
      minor: 3,
      patch: 4,
      stage: "rc",
      qualifier: "2",
    })
  })

  it("throws for invalid version format", () => {
    expect(() => parseVersionString("not-a-version")).toThrow()
    expect(() => parseVersionString("1.2")).toThrow()
    expect(() => parseVersionString("")).toThrow()
  })
})

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.1")).toBe(0)
  })

  it("compares major versions", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0)
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0)
  })

  it("compares minor versions", () => {
    expect(compareVersions("1.2.0", "1.1.0")).toBeGreaterThan(0)
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0)
  })

  it("compares patch versions", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0)
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0)
  })

  it("orders stages: alpha < beta < rc < stable", () => {
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta.1")).toBeLessThan(0)
    expect(compareVersions("1.0.0-beta.1", "1.0.0-rc.1")).toBeLessThan(0)
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0)
  })

  it("orders qualifiers within the same stage", () => {
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0)
    expect(compareVersions("1.0.0-beta.3", "1.0.0-beta.1")).toBeGreaterThan(0)
  })

  it("handles stage without qualifier vs same stage with qualifier", () => {
    // 1.0.0-alpha < 1.0.0-alpha.1 (no qualifier sorts before numeric qualifier)
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0)
  })

  it("correctly sorts the full Maven-style sequence from AC9", () => {
    const versions = [
      "1.0.0",
      "1.0.0-alpha.1",
      "1.0.0-rc.1",
      "1.0.0-beta.1",
    ]
    const sorted = [...versions].sort(compareVersions)
    expect(sorted).toEqual([
      "1.0.0-alpha.1",
      "1.0.0-beta.1",
      "1.0.0-rc.1",
      "1.0.0",
    ])
  })
})

describe("VersionNotFoundError", () => {
  it("is an instance of Error", () => {
    const err = new VersionNotFoundError("workspace", "1.0.0")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("VersionNotFoundError")
    expect(err.agentName).toBe("workspace")
    expect(err.versionSpec).toBe("1.0.0")
    expect(err.message).toContain("workspace")
    expect(err.message).toContain("1.0.0")
  })
})
