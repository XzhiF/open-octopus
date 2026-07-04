/**
 * GraphDependencyResolver 单元测试
 *
 * 覆盖:
 *   - 简单线性依赖链
 *   - 多分支依赖
 *   - 循环依赖检测
 *   - 深度限制
 *   - optional 依赖跳过
 *   - 拓扑排序方向验证
 */
import { describe, it, expect } from "vitest"
import {
  GraphDependencyResolver,
  computeReverseDependencies,
} from "../resource/dependency-resolver"
import type { DependencyLookup } from "../resource/dependency-resolver"
import {
  CircularDependencyError,
  DepthExceededError,
  ResourceNotFoundError,
} from "../resource/errors"
import type { ResourceDependency, ResourceType } from "../types/resource-manifest"

// ── 测试 fixture ────────────────────────────────────────────────

function createMockLookup(
  registry: Record<string, ResourceDependency[]>
): DependencyLookup {
  return (name: string, type: ResourceType) => {
    const key = `${type}:${name}`
    if (key in registry) return registry[key]
    return null // not found
  }
}

describe("GraphDependencyResolver", () => {
  describe("简单依赖链", () => {
    it("单资源无依赖 → 直接返回", () => {
      const lookup = createMockLookup({
        "skill:brainstorming": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "brainstorming", type: "skill" }])

      expect(result.ordered).toHaveLength(1)
      expect(result.ordered[0].name).toBe("brainstorming")
    })

    it("A → B 线性链 → B 先安装", () => {
      const lookup = createMockLookup({
        "agent:security-engineer": [{ name: "security-review", type: "skill", optional: false }],
        "skill:security-review": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "security-engineer", type: "agent" }])

      expect(result.ordered).toHaveLength(2)
      // security-review (依赖) 必须在 security-engineer (被依赖) 之前
      const names = result.ordered.map((n) => n.name)
      expect(names.indexOf("security-review")).toBeLessThan(names.indexOf("security-engineer"))
    })

    it("A → B → C 三级链 → C, B, A 顺序", () => {
      const lookup = createMockLookup({
        "agent:a": [{ name: "b", type: "skill", optional: false }],
        "skill:b": [{ name: "c", type: "skill", optional: false }],
        "skill:c": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "a", type: "agent" }])

      expect(result.ordered).toHaveLength(3)
      const names = result.ordered.map((n) => n.name)
      expect(names.indexOf("c")).toBeLessThan(names.indexOf("b"))
      expect(names.indexOf("b")).toBeLessThan(names.indexOf("a"))
    })
  })

  describe("多分支依赖", () => {
    it("钻石依赖 A→B, A→C, B→D, C→D → D 最先安装", () => {
      const lookup = createMockLookup({
        "agent:a": [
          { name: "b", type: "skill", optional: false },
          { name: "c", type: "skill", optional: false },
        ],
        "skill:b": [{ name: "d", type: "skill", optional: false }],
        "skill:c": [{ name: "d", type: "skill", optional: false }],
        "skill:d": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "a", type: "agent" }])

      expect(result.ordered).toHaveLength(4)
      const names = result.ordered.map((n) => n.name)
      // d 必须在 b 和 c 之前
      expect(names.indexOf("d")).toBeLessThan(names.indexOf("b"))
      expect(names.indexOf("d")).toBeLessThan(names.indexOf("c"))
      // a 必须在最后
      expect(names[names.length - 1]).toBe("a")
    })

    it("多入口点 → 合并依赖图", () => {
      const lookup = createMockLookup({
        "agent:x": [{ name: "shared", type: "skill", optional: false }],
        "agent:y": [{ name: "shared", type: "skill", optional: false }],
        "skill:shared": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([
        { name: "x", type: "agent" },
        { name: "y", type: "agent" },
      ])

      expect(result.ordered).toHaveLength(3)
      const names = result.ordered.map((n) => n.name)
      expect(names.indexOf("shared")).toBeLessThan(names.indexOf("x"))
      expect(names.indexOf("shared")).toBeLessThan(names.indexOf("y"))
    })
  })

  describe("循环依赖检测", () => {
    it("A→B→A → 抛出 CircularDependencyError", () => {
      const lookup = createMockLookup({
        "skill:a": [{ name: "b", type: "skill", optional: false }],
        "skill:b": [{ name: "a", type: "skill", optional: false }],
      })
      const resolver = new GraphDependencyResolver(lookup)

      expect(() => resolver.resolve([{ name: "a", type: "skill" }])).toThrow(
        CircularDependencyError
      )
    })

    it("A→B→C→A → 检测完整循环路径", () => {
      const lookup = createMockLookup({
        "skill:a": [{ name: "b", type: "skill", optional: false }],
        "skill:b": [{ name: "c", type: "skill", optional: false }],
        "skill:c": [{ name: "a", type: "skill", optional: false }],
      })
      const resolver = new GraphDependencyResolver(lookup)

      try {
        resolver.resolve([{ name: "a", type: "skill" }])
        expect.fail("Should have thrown")
      } catch (e) {
        expect(e).toBeInstanceOf(CircularDependencyError)
        const err = e as CircularDependencyError
        expect(err.cycle).toContain("skill:a")
        expect(err.exitCode).toBe(2)
      }
    })

    it("自循环 A→A → 检测", () => {
      const lookup = createMockLookup({
        "skill:a": [{ name: "a", type: "skill", optional: false }],
      })
      const resolver = new GraphDependencyResolver(lookup)

      expect(() => resolver.resolve([{ name: "a", type: "skill" }])).toThrow(
        CircularDependencyError
      )
    })
  })

  describe("深度限制", () => {
    it("超过 maxDepth → 抛出 DepthExceededError", () => {
      const lookup = createMockLookup({
        "skill:d1": [{ name: "d2", type: "skill", optional: false }],
        "skill:d2": [{ name: "d3", type: "skill", optional: false }],
        "skill:d3": [{ name: "d4", type: "skill", optional: false }],
        "skill:d4": [{ name: "d5", type: "skill", optional: false }],
        "skill:d5": [],
      })
      // maxDepth = 2，d1→d2→d3 已经深度 2，d3→d4 超限
      const resolver = new GraphDependencyResolver(lookup, 2)

      expect(() => resolver.resolve([{ name: "d1", type: "skill" }])).toThrow(
        DepthExceededError
      )
    })

    it("深度在限制内 → 正常解析", () => {
      const lookup = createMockLookup({
        "skill:d1": [{ name: "d2", type: "skill", optional: false }],
        "skill:d2": [{ name: "d3", type: "skill", optional: false }],
        "skill:d3": [],
      })
      const resolver = new GraphDependencyResolver(lookup, 3)
      const result = resolver.resolve([{ name: "d1", type: "skill" }])

      expect(result.ordered).toHaveLength(3)
    })
  })

  describe("optional 依赖", () => {
    it("optional 依赖不存在 → 跳过不报错", () => {
      const lookup = createMockLookup({
        "agent:x": [
          { name: "required-skill", type: "skill", optional: false },
          { name: "missing-optional", type: "skill", optional: true },
        ],
        "skill:required-skill": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "x", type: "agent" }])

      expect(result.ordered).toHaveLength(2) // x + required-skill
      const names = result.ordered.map((n) => n.name)
      expect(names).not.toContain("missing-optional")
    })

    it("optional 依赖存在 → 正常包含", () => {
      const lookup = createMockLookup({
        "agent:x": [
          { name: "optional-skill", type: "skill", optional: true },
        ],
        "skill:optional-skill": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([{ name: "x", type: "agent" }])

      expect(result.ordered).toHaveLength(2)
      const names = result.ordered.map((n) => n.name)
      expect(names).toContain("optional-skill")
    })
  })

  describe("资源不存在", () => {
    it("必需依赖不存在 → 抛出 ResourceNotFoundError", () => {
      const lookup = createMockLookup({
        "agent:x": [{ name: "nonexistent", type: "skill", optional: false }],
      })
      const resolver = new GraphDependencyResolver(lookup)

      expect(() => resolver.resolve([{ name: "x", type: "agent" }])).toThrow(
        ResourceNotFoundError
      )
    })

    it("入口资源不存在 → 抛出 ResourceNotFoundError", () => {
      const lookup = createMockLookup({})
      const resolver = new GraphDependencyResolver(lookup)

      expect(() => resolver.resolve([{ name: "ghost", type: "skill" }])).toThrow(
        ResourceNotFoundError
      )
    })
  })

  describe("反向依赖计算", () => {
    it("查找谁依赖了给定资源", () => {
      const lookup = createMockLookup({
        "agent:a": [{ name: "shared", type: "skill", optional: false }],
        "agent:b": [{ name: "shared", type: "skill", optional: false }],
        "skill:shared": [],
      })
      const resolver = new GraphDependencyResolver(lookup)
      const result = resolver.resolve([
        { name: "a", type: "agent" },
        { name: "b", type: "agent" },
      ])

      const dependents = computeReverseDependencies(result.graph, "skill:shared")
      expect(dependents).toContain("agent:a")
      expect(dependents).toContain("agent:b")
      expect(dependents).toHaveLength(2)
    })
  })
})
