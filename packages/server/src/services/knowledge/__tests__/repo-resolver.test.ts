import { describe, it, expect } from "vitest"
import { parseRepoNameFromUrl, resolveRepoName } from "../repo-resolver"

describe("parseRepoNameFromUrl", () => {
  it("parses SSH URL", () => {
    expect(parseRepoNameFromUrl("git@github.com:XzhiF/octopus.git")).toBe("octopus")
  })

  it("parses HTTPS URL", () => {
    expect(parseRepoNameFromUrl("https://github.com/XzhiF/my-app.git")).toBe("my-app")
  })

  it("parses HTTPS URL without .git suffix", () => {
    expect(parseRepoNameFromUrl("https://github.com/XzhiF/my-app")).toBe("my-app")
  })

  it("parses SSH URL without .git suffix", () => {
    expect(parseRepoNameFromUrl("git@github.com:org/repo")).toBe("repo")
  })

  it("throws on unparseable URL", () => {
    expect(() => parseRepoNameFromUrl("not-a-url")).toThrow()
  })
})

describe("resolveRepoName", () => {
  it("falls back to directory basename when not in a git repo", () => {
    const result = resolveRepoName("/tmp")
    expect(result).toBe("tmp")
  })
})
