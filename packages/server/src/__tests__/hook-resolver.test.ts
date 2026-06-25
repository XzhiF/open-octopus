// packages/server/src/__tests__/hook-resolver.test.ts
import { describe, it, expect } from "vitest"
import { HookResolver } from "../services/hook-resolver"

describe("HookResolver", () => {
  const resolver = new HookResolver()

  it("returns workflow hooks when workflow defines the event", () => {
    const wfHooks = {
      on_node_success: [{ id: "wf-hook", type: "bash" as const, bash: "echo workflow" }],
    }
    const pipelineHooks = {
      on_node_success: [{ id: "pipeline-hook", type: "bash" as const, bash: "echo pipeline" }],
    }
    const result = resolver.resolve("on_node_success", wfHooks, pipelineHooks)
    expect(result).toEqual(wfHooks.on_node_success)
  })

  it("returns pipeline hooks when workflow does not define the event", () => {
    const wfHooks = {
      on_node_failure: [{ id: "wf-fail", type: "bash" as const, bash: "echo fail" }],
    }
    const pipelineHooks = {
      on_node_success: [{ id: "pipeline-success", type: "bash" as const, bash: "echo success" }],
    }
    const result = resolver.resolve("on_node_success", wfHooks, pipelineHooks)
    expect(result).toEqual(pipelineHooks.on_node_success)
  })

  it("returns empty array when workflow explicitly defines empty array", () => {
    const wfHooks = {
      on_node_success: [],
    }
    const pipelineHooks = {
      on_node_success: [{ id: "pipeline-hook", type: "bash" as const, bash: "echo pipeline" }],
    }
    const result = resolver.resolve("on_node_success", wfHooks, pipelineHooks)
    expect(result).toEqual([])
  })

  it("returns empty array when neither defines the event", () => {
    const result = resolver.resolve("on_node_success", undefined, undefined)
    expect(result).toEqual([])
  })

  it("returns pipeline hooks when workflow hooks is undefined", () => {
    const pipelineHooks = {
      on_node_success: [{ id: "pipeline-hook", type: "bash" as const, bash: "echo pipeline" }],
    }
    const result = resolver.resolve("on_node_success", undefined, pipelineHooks)
    expect(result).toEqual(pipelineHooks.on_node_success)
  })

  it("hasHooks returns true when hooks exist", () => {
    const wfHooks = {
      on_node_success: [{ id: "hook", type: "bash" as const, bash: "echo" }],
    }
    expect(resolver.hasHooks("on_node_success", wfHooks, undefined)).toBe(true)
  })

  it("hasHooks returns false when no hooks", () => {
    expect(resolver.hasHooks("on_node_success", undefined, undefined)).toBe(false)
  })

  it("hasHooks returns false when workflow defines empty array", () => {
    const wfHooks = {
      on_node_success: [],
    }
    expect(resolver.hasHooks("on_node_success", wfHooks, undefined)).toBe(false)
  })
})
