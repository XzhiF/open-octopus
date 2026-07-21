import { describe, it, expect } from "vitest"
import {
  parseManifestJson,
  writeManifestJson,
  parseIndexJson,
  writeIndexJson,
  type ManifestEntry,
  type IndexEntry,
} from "../repo-ops/mod"

describe("parseManifestJson", () => {
  it("parses valid JSON with groups structure", () => {
    const json = JSON.stringify({
      groups: {
        xzf: [
          { name: "project-a", git_url: "https://github.com/xzf/a.git", branch: "main", manual_tags: ["web"], group: "xzf" },
          { name: "project-b", git_url: "https://github.com/xzf/b.git", branch: "master", manual_tags: [], group: "xzf" },
        ],
      },
    })
    const result = parseManifestJson(json)
    expect(result).toEqual({
      xzf: [
        { name: "project-a", git_url: "https://github.com/xzf/a.git", branch: "main", manual_tags: ["web"], group: "xzf" },
        { name: "project-b", git_url: "https://github.com/xzf/b.git", branch: "master", manual_tags: [], group: "xzf" },
      ],
    })
  })

  it("returns empty object for empty string", () => {
    expect(parseManifestJson("")).toEqual({})
    expect(parseManifestJson("   ")).toEqual({})
  })

  it("returns empty object for empty JSON object", () => {
    expect(parseManifestJson("{}")).toEqual({})
    expect(parseManifestJson('{"groups":{}}')).toEqual({})
  })

  it("throws clear error for invalid JSON", () => {
    expect(() => parseManifestJson("{invalid}")).toThrow("Invalid manifest JSON")
    expect(() => parseManifestJson("not json at all")).toThrow("Invalid manifest JSON")
  })

  it("throws error when entry missing name field", () => {
    const json = JSON.stringify({
      groups: {
        xzf: [{ git_url: "https://github.com/xzf/a.git" }],
      },
    })
    expect(() => parseManifestJson(json)).toThrow("missing required field 'name'")
  })

  it("applies defaults for missing optional fields", () => {
    const json = JSON.stringify({
      groups: {
        xzf: [{ name: "project-a" }],
      },
    })
    const result = parseManifestJson(json)
    expect(result.xzf[0]).toEqual({
      name: "project-a",
      git_url: "",
      branch: "master",
      manual_tags: [],
      group: "xzf",
    })
  })

  it("handles special character URLs", () => {
    const json = JSON.stringify({
      groups: {
        xzf: [
          { name: "project-with-parens", git_url: "https://github.com/xzf/repo(1).git", branch: "main", manual_tags: [], group: "xzf" },
          { name: "project-with-spaces", git_url: "https://github.com/xzf/my%20repo.git", branch: "main", manual_tags: [], group: "xzf" },
        ],
      },
    })
    const result = parseManifestJson(json)
    expect(result.xzf).toHaveLength(2)
    expect(result.xzf[0].git_url).toBe("https://github.com/xzf/repo(1).git")
    expect(result.xzf[1].git_url).toBe("https://github.com/xzf/my%20repo.git")
  })

  it("supports bare object format (without groups wrapper)", () => {
    const json = JSON.stringify({
      xzf: [{ name: "project-a", git_url: "", branch: "master", manual_tags: [], group: "xzf" }],
    })
    const result = parseManifestJson(json)
    expect(result.xzf).toHaveLength(1)
  })

  it("skips non-array group values", () => {
    const json = JSON.stringify({
      groups: {
        xzf: [{ name: "valid" }],
        invalid: "not an array",
        alsoInvalid: 42,
      },
    })
    const result = parseManifestJson(json)
    expect(result.xzf).toHaveLength(1)
    expect(result.invalid).toBeUndefined()
    expect(result.alsoInvalid).toBeUndefined()
  })
})

describe("writeManifestJson", () => {
  it("serializes groups to formatted JSON", () => {
    const entries: Record<string, ManifestEntry[]> = {
      xzf: [
        { name: "project-a", git_url: "https://github.com/xzf/a.git", branch: "main", manual_tags: ["web"], group: "xzf" },
      ],
    }
    const json = writeManifestJson(entries)
    expect(json).toContain('"groups"')
    expect(json).toContain('"project-a"')
    expect(json.endsWith("\n")).toBe(true)

    // Round-trip test
    const parsed = parseManifestJson(json)
    expect(parsed).toEqual(entries)
  })

  it("handles empty groups", () => {
    const json = writeManifestJson({})
    expect(parseManifestJson(json)).toEqual({})
  })
})

describe("parseIndexJson", () => {
  it("parses valid JSON array", () => {
    const entries: IndexEntry[] = [
      {
        name: "project-a",
        git_url: "https://github.com/xzf/a.git",
        branch: "main",
        tags: ["web", "api"],
        tag_source: "manual",
        description: "A web project",
        desc_source: "readme",
        local_path: "/home/user/repos/a",
        knowledge_line: "repowiki ✓",
      },
    ]
    const json = JSON.stringify(entries)
    const result = parseIndexJson(json)
    expect(result).toEqual(entries)
  })

  it("returns empty array for empty string", () => {
    expect(parseIndexJson("")).toEqual([])
    expect(parseIndexJson("   ")).toEqual([])
  })

  it("returns empty array for empty JSON array", () => {
    expect(parseIndexJson("[]")).toEqual([])
  })

  it("throws clear error for invalid JSON", () => {
    expect(() => parseIndexJson("{invalid}")).toThrow("Invalid index JSON")
  })

  it("throws error when entry missing name field", () => {
    const json = JSON.stringify([{ git_url: "https://github.com/xzf/a.git" }])
    expect(() => parseIndexJson(json)).toThrow("missing required field 'name'")
  })

  it("applies defaults for missing optional fields", () => {
    const json = JSON.stringify([{ name: "project-a" }])
    const result = parseIndexJson(json)
    expect(result[0]).toEqual({
      name: "project-a",
      git_url: "",
      branch: "master",
      tags: [],
      tag_source: "",
      description: "",
      desc_source: "",
      local_path: null,
      knowledge_line: "",
    })
  })

  it("supports { entries: [...] } wrapper format", () => {
    const json = JSON.stringify({
      entries: [{ name: "project-a", git_url: "", branch: "master", tags: [], tag_source: "", description: "", desc_source: "", local_path: null, knowledge_line: "" }],
    })
    const result = parseIndexJson(json)
    expect(result).toHaveLength(1)
  })
})

describe("writeIndexJson", () => {
  it("serializes entries to formatted JSON", () => {
    const entries: IndexEntry[] = [
      {
        name: "project-a",
        git_url: "https://github.com/xzf/a.git",
        branch: "main",
        tags: ["web"],
        tag_source: "manual",
        description: "A project",
        desc_source: "readme",
        local_path: null,
        knowledge_line: "",
      },
    ]
    const json = writeIndexJson(entries)
    expect(json).toContain('"project-a"')
    expect(json.endsWith("\n")).toBe(true)

    // Round-trip test
    const parsed = parseIndexJson(json)
    expect(parsed).toEqual(entries)
  })

  it("handles empty array", () => {
    const json = writeIndexJson([])
    expect(parseIndexJson(json)).toEqual([])
  })
})
