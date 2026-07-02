import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { parseRepoNameFromUrl, resolveRepoName, resolveAllProjectNames } from "../repo-resolver"

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

describe("resolveAllProjectNames", () => {
  it("falls back to single repo when no projects/ directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-test-"))
    try {
      const result = resolveAllProjectNames(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(path.basename(tmpDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("returns deduplicated names from projects/ subdirectories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-test-"))
    const projectsDir = path.join(tmpDir, "projects")
    fs.mkdirSync(projectsDir, { recursive: true })
    // Create non-git subdirectories — they'll fall back to directory name
    fs.mkdirSync(path.join(projectsDir, "alpha"))
    fs.mkdirSync(path.join(projectsDir, "beta"))

    try {
      const result = resolveAllProjectNames(tmpDir)
      expect(result).toContain("alpha")
      expect(result).toContain("beta")
      expect(result).toHaveLength(2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("falls back to workspace root when projects/ is empty", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-test-"))
    const projectsDir = path.join(tmpDir, "projects")
    fs.mkdirSync(projectsDir, { recursive: true })

    try {
      const result = resolveAllProjectNames(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0]).toBe(path.basename(tmpDir))
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
