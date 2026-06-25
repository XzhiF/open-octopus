// packages/engine/src/__tests__/prompt-injector.test.ts
import { describe, it, expect } from "vitest"
import { PromptInjector } from "../prompt-injector"

describe("PromptInjector", () => {
  it("returns empty array when config is undefined", () => {
    const injector = new PromptInjector(undefined)
    expect(injector.getInjectedPrompts("workflow", "node")).toEqual([])
  })

  it("returns global prompts", () => {
    const injector = new PromptInjector({
      global: ["Global rule 1", "Global rule 2"],
      targeted: [],
    })
    const prompts = injector.getInjectedPrompts("workflow", "node")
    expect(prompts).toEqual(["Global rule 1", "Global rule 2"])
  })

  it("returns targeted prompts with exact match", () => {
    const injector = new PromptInjector({
      global: [],
      targeted: [
        { workflow: "dev-workflow", node: "code-review", prompt: "Focus on security" },
      ],
    })
    const prompts = injector.getInjectedPrompts("dev-workflow", "code-review")
    expect(prompts).toEqual(["Focus on security"])
  })

  it("returns targeted prompts with wildcard node", () => {
    const injector = new PromptInjector({
      global: [],
      targeted: [
        { workflow: "test-workflow", node: "*", prompt: "Check test quality" },
      ],
    })
    const prompts = injector.getInjectedPrompts("test-workflow", "any-node")
    expect(prompts).toEqual(["Check test quality"])
  })

  it("prioritizes exact match over wildcard", () => {
    const injector = new PromptInjector({
      global: [],
      targeted: [
        { workflow: "dev-workflow", node: "*", prompt: "Wildcard" },
        { workflow: "dev-workflow", node: "code-review", prompt: "Exact" },
      ],
    })
    const prompts = injector.getInjectedPrompts("dev-workflow", "code-review")
    expect(prompts).toEqual(["Exact", "Wildcard"])
  })

  it("combines global and targeted prompts", () => {
    const injector = new PromptInjector({
      global: ["Global"],
      targeted: [
        { workflow: "dev-workflow", node: "code-review", prompt: "Targeted" },
      ],
    })
    const prompts = injector.getInjectedPrompts("dev-workflow", "code-review")
    expect(prompts).toEqual(["Global", "Targeted"])
  })

  it("truncates when total length exceeds 5000 chars", () => {
    const longPrompt = "x".repeat(3000)
    const injector = new PromptInjector({
      global: [longPrompt, longPrompt],
      targeted: [],
    })
    const prompts = injector.getInjectedPrompts("workflow", "node")
    const totalLength = prompts.reduce((sum, p) => sum + p.length, 0)
    expect(totalLength).toBeLessThanOrEqual(5000)
  })

  it("does not match when workflow name differs", () => {
    const injector = new PromptInjector({
      global: [],
      targeted: [
        { workflow: "dev-workflow", node: "node", prompt: "Dev only" },
      ],
    })
    const prompts = injector.getInjectedPrompts("test-workflow", "node")
    expect(prompts).toEqual([])
  })
})
