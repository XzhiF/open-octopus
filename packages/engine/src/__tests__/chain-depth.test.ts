import { describe, it, expect, vi } from "vitest"
import { WorkflowEngine } from "../engine"
import type { WorkflowDef } from "@octopus/shared"

function createChainWorkflow(chain: any): WorkflowDef {
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "chain-workflow",
    nodes: [{ id: "step-1", type: "bash", bash: "echo done" }],
    chain,
  } as WorkflowDef
}

describe("TC-037: chain depth guard", () => {
  it("emits onChainTrigger when depth < 5", async () => {
    const onChainTrigger = vi.fn()
    const wf = createChainWorkflow({
      on_success: [{ workflow: "next.yaml", auto_trigger: true }],
    })
    const engine = new WorkflowEngine(
      wf, {}, process.cwd(), undefined,
      { onChainTrigger }, undefined,
      undefined, undefined, undefined, undefined, undefined,
      4, // chainDepth = 4, under limit
    )
    await engine.run()
    expect(onChainTrigger).toHaveBeenCalledOnce()
  })

  it("aborts chain trigger when depth >= 5", async () => {
    const onChainTrigger = vi.fn()
    const wf = createChainWorkflow({
      on_success: [{ workflow: "next.yaml", auto_trigger: true }],
    })
    const engine = new WorkflowEngine(
      wf, {}, process.cwd(), undefined,
      { onChainTrigger }, undefined,
      undefined, undefined, undefined, undefined, undefined,
      5, // chainDepth = 5, at limit
    )
    await engine.run()
    expect(onChainTrigger).not.toHaveBeenCalled()
  })

  it("aborts chain trigger when depth > 5", async () => {
    const onChainTrigger = vi.fn()
    const wf = createChainWorkflow({
      on_success: [{ workflow: "next.yaml", auto_trigger: true }],
    })
    const engine = new WorkflowEngine(
      wf, {}, process.cwd(), undefined,
      { onChainTrigger }, undefined,
      undefined, undefined, undefined, undefined, undefined,
      7, // chainDepth = 7, well over limit
    )
    await engine.run()
    expect(onChainTrigger).not.toHaveBeenCalled()
  })

  it("defaults to depth 0 when not specified", async () => {
    const onChainTrigger = vi.fn()
    const wf = createChainWorkflow({
      on_success: [{ workflow: "next.yaml", auto_trigger: true }],
    })
    const engine = new WorkflowEngine(
      wf, {}, process.cwd(), undefined,
      { onChainTrigger },
    )
    await engine.run()
    expect(onChainTrigger).toHaveBeenCalledOnce()
  })
})
