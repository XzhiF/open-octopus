/**
 * ResourceManifest Schema 单元测试
 */
import { describe, it, expect } from "vitest"
import {
  ResourceManifestSchema,
  registryKey,
  flattenResourceDeclarations,
  getDefaultTarget,
  isValidResourceName,
  WorkspaceResourcesSchema,
  ResourceAuditActionSchema,
  TrustedSourceEntrySchema,
} from "../types/resource-manifest"
import { LockResourceEntrySchema as LockEntrySchema } from "../types/lock-file"

describe("ResourceManifestSchema", () => {
  it("接受合法的最小 manifest", () => {
    const result = ResourceManifestSchema.safeParse({
      name: "brainstorming",
      type: "skill",
      source: { protocol: "npm", package: "superpowers-zh" },
    })
    expect(result.success).toBe(true)
  })

  it("拒绝非法名称（特殊字符）", () => {
    const result = ResourceManifestSchema.safeParse({
      name: "bad name!@#",
      type: "skill",
      source: { protocol: "builtin", id: "test" },
    })
    expect(result.success).toBe(false)
  })

  it("拒绝以非字母数字开头的名称", () => {
    const result = ResourceManifestSchema.safeParse({
      name: "-bad-start",
      type: "skill",
      source: { protocol: "builtin", id: "test" },
    })
    expect(result.success).toBe(false)
  })

  it("接受包含 dependencies 的完整 manifest", () => {
    const result = ResourceManifestSchema.safeParse({
      name: "security-engineer",
      type: "agent",
      version: "1.0.0",
      description: "Security audit agent",
      source: { protocol: "github", repo: "jnMetaCode/agency-agents-zh", ref: "main" },
      dependencies: [
        { name: "security-review", type: "skill", optional: false },
        { name: "optional-tool", type: "skill", optional: true },
      ],
      tags: ["security", "audit"],
      extends: { department: "engineering" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.dependencies).toHaveLength(2)
      expect(result.data.tags).toContain("security")
    }
  })

  it("拒绝 files 中包含 '..' 的路径", () => {
    const result = ResourceManifestSchema.safeParse({
      name: "test",
      type: "skill",
      source: { protocol: "local", path: "/tmp" },
      files: ["../etc/passwd"],
    })
    expect(result.success).toBe(false)
  })

  it("接受 4 种 SourceRef 协议", () => {
    const protocols = [
      { protocol: "npm", package: "superpowers-zh" },
      { protocol: "github", repo: "owner/repo" },
      { protocol: "local", path: "/tmp/test" },
      { protocol: "builtin", id: "test-skill" },
    ]

    for (const source of protocols) {
      const result = ResourceManifestSchema.safeParse({
        name: "test",
        type: "skill",
        source,
      })
      expect(result.success).toBe(true)
    }
  })
})

describe("辅助函数", () => {
  it("registryKey 格式正确", () => {
    expect(registryKey("skill", "test")).toBe("skill:test")
    expect(registryKey("agent", "security-engineer")).toBe("agent:security-engineer")
  })

  it("flattenResourceDeclarations 展开分组", () => {
    const targets = flattenResourceDeclarations({
      skills: ["a", "b"],
      agents: ["c"],
      workflows: [],
      sources: ["d"],
    })
    expect(targets).toHaveLength(4)
    expect(targets.find((t) => t.name === "a")!.type).toBe("skill")
    expect(targets.find((t) => t.name === "c")!.type).toBe("agent")
  })

  it("getDefaultTarget 返回正确默认值", () => {
    expect(getDefaultTarget("skill").dir).toBe(".claude/skills")
    expect(getDefaultTarget("agent").dir).toBe(".claude/agents")
    expect(getDefaultTarget("workflow").dir).toBe("workflows")
    expect(getDefaultTarget("source").dir).toBe("dependencies")
  })

  it("isValidResourceName 校验", () => {
    expect(isValidResourceName("valid-name")).toBe(true)
    expect(isValidResourceName("valid_name123")).toBe(true)
    expect(isValidResourceName("123start")).toBe(true)
    expect(isValidResourceName("-invalid")).toBe(false)
    expect(isValidResourceName("")).toBe(false)
    expect(isValidResourceName("a".repeat(101))).toBe(false)
  })
})

describe("WorkspaceResourcesSchema", () => {
  it("接受带分组资源的声明", () => {
    const result = WorkspaceResourcesSchema.safeParse({
      skills: ["brainstorming", "writing-plans"],
      agents: ["security-engineer"],
      workflows: [],
      sources: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skills).toHaveLength(2)
    }
  })
})

describe("LockEntrySchema", () => {
  it("接受合法的锁定条目", () => {
    const result = LockEntrySchema.safeParse({
      name: "brainstorming",
      type: "skill",
      hash: "a1b2c3d4e5f6",
      source: { protocol: "npm", package: "superpowers-zh" },
      installed_at: "2026-07-05T10:29:55Z",
      target: ".claude/skills/brainstorming",
      installed_by: "human",
    })
    expect(result.success).toBe(true)
  })
})

describe("TrustedSourceEntrySchema", () => {
  it("接受信任条目", () => {
    const result = TrustedSourceEntrySchema.safeParse({
      protocol: "npm",
      package: "superpowers-zh",
      trusted_at: "2026-07-05",
    })
    expect(result.success).toBe(true)
  })
})

describe("ResourceAuditActionSchema", () => {
  it("接受合法动作", () => {
    expect(ResourceAuditActionSchema.safeParse("resource.installed").success).toBe(true)
    expect(ResourceAuditActionSchema.safeParse("cache.gc").success).toBe(true)
    expect(ResourceAuditActionSchema.safeParse("invalid-action").success).toBe(false)
  })
})
