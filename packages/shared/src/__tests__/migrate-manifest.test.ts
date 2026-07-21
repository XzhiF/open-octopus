import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { parseManifest, writeManifestJson, parseManifestJson } from "../repo-ops/mod"

/**
 * Tests for the migration logic (manifest.md → manifest.json).
 * These tests verify the core migration transformation without
 * needing to run the actual script.
 */
describe("manifest migration transform", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "octopus-migrate-test-"))
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("migrates standard format with correct record count", () => {
    const mdContent = `# Manifest

## xzf (xzf)

- order-service [main] {backend/api} https://github.com/xzf/order-service.git
- user-service [main] {backend} https://github.com/xzf/user-service.git
- web-app [develop] {frontend} https://github.com/xzf/web-app.git

## xzf-tools (tools)

- deploy-tool [master] https://github.com/xzf/deploy-tool.git
`
    // Parse markdown
    const groups = parseManifest(mdContent)

    // Count source records
    let sourceCount = 0
    for (const entries of Object.values(groups)) {
      sourceCount += entries.length
    }
    expect(sourceCount).toBe(4)

    // Convert to JSON
    const jsonContent = writeManifestJson(groups)
    writeFileSync(join(tmpDir, "manifest.json"), jsonContent, "utf-8")

    // Verify JSON
    const readBack = readFileSync(join(tmpDir, "manifest.json"), "utf-8")
    const jsonGroups = parseManifestJson(readBack)

    // Count target records
    let targetCount = 0
    for (const entries of Object.values(jsonGroups)) {
      targetCount += entries.length
    }
    expect(targetCount).toBe(sourceCount)

    // Verify field content
    expect(jsonGroups.xzf).toHaveLength(3)
    expect(jsonGroups.xzf[0].name).toBe("order-service")
    expect(jsonGroups.xzf[0].branch).toBe("main")
    expect(jsonGroups.xzf[0].manual_tags).toEqual(["backend", "api"])
    expect(jsonGroups.xzf[0].git_url).toBe("https://github.com/xzf/order-service.git")
  })

  it("preserves special character URLs", () => {
    const mdContent = `## test

- repo-with-parens https://github.com/test/repo(1).git
- repo-with-spaces https://github.com/test/my%20repo.git
- ssh-repo git@github.com:test/private-repo.git
`
    const groups = parseManifest(mdContent)
    const jsonContent = writeManifestJson(groups)
    const jsonGroups = parseManifestJson(jsonContent)

    expect(jsonGroups.test).toHaveLength(3)
    expect(jsonGroups.test[0].git_url).toBe("https://github.com/test/repo(1).git")
    expect(jsonGroups.test[1].git_url).toBe("https://github.com/test/my%20repo.git")
    expect(jsonGroups.test[2].git_url).toBe("git@github.com:test/private-repo.git")
  })

  it("handles empty manifest", () => {
    const mdContent = `# Empty Manifest

> No repos configured yet.
`
    const groups = parseManifest(mdContent)
    expect(Object.keys(groups)).toHaveLength(0)

    const jsonContent = writeManifestJson(groups)
    const jsonGroups = parseManifestJson(jsonContent)
    expect(Object.keys(jsonGroups)).toHaveLength(0)
  })

  it("preserves all required fields for each record", () => {
    const mdContent = `## mygroup

- my-project [feature-branch] {tag1/tag2} https://github.com/org/my-project.git
`
    const groups = parseManifest(mdContent)
    const jsonContent = writeManifestJson(groups)
    const jsonGroups = parseManifestJson(jsonContent)

    const entry = jsonGroups.mygroup[0]
    expect(entry.name).toBe("my-project")
    expect(entry.branch).toBe("feature-branch")
    expect(entry.manual_tags).toEqual(["tag1", "tag2"])
    expect(entry.git_url).toBe("https://github.com/org/my-project.git")
    expect(entry.group).toBe("mygroup")
  })

  it("round-trips through write then parse", () => {
    const original = {
      groupA: [
        { name: "proj1", git_url: "https://github.com/a/proj1.git", branch: "main", manual_tags: ["web"], group: "groupA" },
        { name: "proj2", git_url: "https://github.com/a/proj2.git", branch: "develop", manual_tags: [], group: "groupA" },
      ],
      groupB: [
        { name: "proj3", git_url: "git@github.com:b/proj3.git", branch: "master", manual_tags: ["api", "backend"], group: "groupB" },
      ],
    }

    const json = writeManifestJson(original)
    const parsed = parseManifestJson(json)

    expect(parsed).toEqual(original)
  })
})
