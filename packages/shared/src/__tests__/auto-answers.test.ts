import { describe, it, expect } from "vitest"
import { compileAutoAnswers } from "../auto-answers/compiler"
import { AutoAnswer } from "../types/workflow"

describe("compileAutoAnswers", () => {
  it("returns empty string when no answers", () => {
    expect(compileAutoAnswers([], [])).toBe("")
  })

  it("compiles global answers only", () => {
    const globalAnswers: AutoAnswer[] = [
      { pattern: "是否使用 TDD", answer: "是（推荐）" },
      { pattern: "*", answer: "推荐选项" },
    ]
    const result = compileAutoAnswers(globalAnswers, [])
    expect(result).toContain("是否使用 TDD")
    expect(result).toContain("推荐选项")
    expect(result).toContain("不要停下来等待用户回复")
    expect(result).toContain("任何其他问题")
  })

  it("merges global and node answers", () => {
    const globalAnswers: AutoAnswer[] = [
      { pattern: "是否使用 TDD", answer: "是（推荐）" },
      { pattern: "*", answer: "推荐选项" },
    ]
    const nodeAnswers: AutoAnswer[] = [
      { pattern: "验证模式", answer: "仅预检" },
    ]
    const result = compileAutoAnswers(globalAnswers, nodeAnswers)
    expect(result).toContain("验证模式")
    expect(result).toContain("是否使用 TDD")
    expect(result).toContain("仅预检")
  })

  it("formats wildcard answer correctly", () => {
    const answers: AutoAnswer[] = [
      { pattern: "*", answer: "推荐选项" },
    ]
    const result = compileAutoAnswers(answers, [])
    expect(result).toContain("任何其他问题 → 选择 \"推荐选项\"")
    expect(result).toContain("优先选择标注了\"推荐\"的选项")
  })

  it("formats pattern answer correctly", () => {
    const answers: AutoAnswer[] = [
      { pattern: "测试框架", answer: "pytest" },
    ]
    const result = compileAutoAnswers(answers, [])
    expect(result).toContain("匹配 \"测试框架\" → 选择 \"pytest\"")
  })
})