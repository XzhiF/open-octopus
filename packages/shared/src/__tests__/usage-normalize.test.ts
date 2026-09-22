// packages/shared/src/__tests__/usage-normalize.test.ts
//
// billing NEW-r2 —— normalizeModelId 契约（Q9）：尾部括号残渣**循环**剥离至不动点；
// 只碰末尾，中段不伤；null 透传。落账端与配价端共用此唯一实现。

import { describe, it, expect } from "vitest"
import { normalizeModelId } from "../types/usage"

describe("normalizeModelId", () => {
  it("null/undefined 透传", () => {
    expect(normalizeModelId(null)).toBeNull()
    expect(normalizeModelId(undefined)).toBeNull()
  })

  it("剥单层上下文窗口后缀", () => {
    expect(normalizeModelId("qwen3.8-flash[1M]")).toBe("qwen3.8-flash")
    expect(normalizeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8") // 大小写无关，整组剥
  })

  it("剥嵌套/粘连残渣至不动点（代理病态输出）", () => {
    expect(normalizeModelId("qwen3.8-flash[1M]][1M]")).toBe("qwen3.8-flash")
    expect(normalizeModelId("m[a][b][c]")).toBe("m")
    expect(normalizeModelId("m[1M] ]")).toBe("m")
  })

  it("孤立右括号残渣也算", () => {
    expect(normalizeModelId("m]]")).toBe("m")
    expect(normalizeModelId("m[1M]]]")).toBe("m")
  })

  it("只剥末尾 —— 中段括号与合法名字原样保留", () => {
    expect(normalizeModelId("foo[beta]-v2")).toBe("foo[beta]-v2")
    expect(normalizeModelId("claude-3-5-sonnet")).toBe("claude-3-5-sonnet")
    expect(normalizeModelId("")).toBe("")
    expect(normalizeModelId("  spaced-model  ")).toBe("spaced-model")
  })

  it("幂等：normalize(normalize(x)) == normalize(x)", () => {
    for (const x of ["a[1M]", "a[1M]][1M]", "plain", "m]]", "x[y]z[w]"]) {
      expect(normalizeModelId(normalizeModelId(x))).toBe(normalizeModelId(x))
    }
  })
})
