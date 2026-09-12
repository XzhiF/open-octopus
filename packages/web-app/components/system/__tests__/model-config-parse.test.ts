import { describe, it, expect } from "vitest"
import { parseProviders } from "../model-config-page"

// 真实 models.yaml 形状(节选):custom_providers 下每个模型都有嵌套的
// cost:/models: 空值键 —— 旧正则会把它们当成 provider 名,产生重复的
// "custom-cost",React 报 Encountered two children with the same key。
const YAML = `default: pro
providers:
  pi:
    pro-max: my-ai/glm-5.2
    pro: dashscope/qwen3.7-plus
  claude:
    pro-max: opus
    pro: sonnet
custom_providers:
  dashscope:
    base_url: https://example.com/v1
    api: openai-completions
    env_key: DASHSCOPE_API_KEY
    models:
      - id: qwen3.7-max
        name: Qwen 3.7 Max
        cost:
          input: 0
          output: 0
      - id: qwen3-max
        name: Qwen 3 Max
        cost:
          input: 0
          output: 0
  my-ai:
    base_url: https://aigw.example.com/v1
    api: openai-completions
    env_key: MY_AI_API_KEY
    models:
      - id: glm-5.2
        name: GLM 5.2
        cost:
          input: 0
          output: 0
`

describe("parseProviders", () => {
  it("returns only top-level provider names", () => {
    expect(parseProviders(YAML)).toEqual([
      { name: "pi", kind: "builtin" },
      { name: "claude", kind: "builtin" },
      { name: "dashscope", kind: "custom" },
      { name: "my-ai", kind: "custom" },
    ])
  })

  it("never yields duplicate kind+name keys (nested cost:/models: excluded)", () => {
    const keys = parseProviders(YAML).map((p) => `${p.kind}-${p.name}`)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).not.toContain("custom-cost")
    expect(keys).not.toContain("custom-models")
  })

  it("handles missing blocks", () => {
    expect(parseProviders("default: pro\n")).toEqual([])
  })
})
