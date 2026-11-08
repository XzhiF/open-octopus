import { describe, expect, it, vi } from "vitest"
import { ActionExecutor } from "../action-executor"

function serviceStub(status: string) {
  return {
    getById: vi.fn(() => ({ id: "exec-1", status })),
    resume: vi.fn(async () => ({ success: false, error: "未找到暂停节点" })),
    retryPausedNode: vi.fn(async () => ({ id: "exec-1", status: "running" })),
    retry: vi.fn(async () => ({ id: "exec-1", status: "running" })),
    pause: vi.fn(async () => ({ success: true })),
    cancel: vi.fn(async () => ({ id: "exec-1", status: "cancelled" })),
  }
}

function build(service: ReturnType<typeof serviceStub>, repair: Record<string, unknown> = {}) {
  return new ActionExecutor({
    getExecutionService: () => ({ service: service as never, wsPath: "/tmp/ws" }),
    getRepairService: () => repair as never,
  })
}

describe("ActionExecutor — 决策落地", () => {
  it("paused + 无 paused 节点（harness_delegate）→ retryPausedNode", async () => {
    const service = serviceStub("paused")
    const executor = build(service)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "retry", hint: "换一种写法" },
    })
    expect(result.ok).toBe(true)
    expect(service.resume).toHaveBeenCalledWith("exec-1", undefined)
    // retry is a plain re-run; the hint is not pushed through the agent
    // intervention path (that is `inject`).
    expect(service.retryPausedNode).toHaveBeenCalledWith("exec-1", "n1", undefined)
  })

  it("failed → 普通 retry", async () => {
    const service = serviceStub("failed")
    const executor = build(service)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "retry" },
    })
    expect(result.ok).toBe(true)
    expect(service.retry).toHaveBeenCalledWith("exec-1", "n1", undefined, undefined)
  })

  it("retry 带变量补丁先写 VarPool", async () => {
    const service = serviceStub("failed")
    const repair = { patchVarPool: vi.fn(() => ({ updated: 1, snapshot: {} })) }
    const executor = build(service, repair)
    await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "retry", varPoolPatches: { API_KEY: "x" } },
    })
    expect(repair.patchVarPool).toHaveBeenCalledWith("exec-1", { API_KEY: "x" })
  })

  it("reload 后把暂停执行重新拉起（否则只换快照没人消费）", async () => {
    const service = serviceStub("paused")
    const repair = { reloadWorkflow: vi.fn(() => ({ reloaded: true, diff: ["+ node gate"] })) }
    const executor = build(service, repair)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "reload", yaml: "name: demo" },
    })
    expect(result.ok).toBe(true)
    expect(repair.reloadWorkflow).toHaveBeenCalledWith("exec-1", "name: demo")
    expect(service.retryPausedNode).toHaveBeenCalledWith("exec-1", "n1", undefined)
  })

  it("abort → cancel", async () => {
    const service = serviceStub("running")
    const executor = build(service)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "abort", reason: "stop" },
    })
    expect(result.ok).toBe(true)
    expect(service.cancel).toHaveBeenCalledWith("exec-1")
  })

  it("终态执行拒绝动作", async () => {
    const service = serviceStub("completed")
    const executor = build(service)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "retry" },
    })
    expect(result.ok).toBe(false)
    expect(service.retry).not.toHaveBeenCalled()
  })

  it("block 无法在引擎外安全落地 → 明确报错", async () => {
    const service = serviceStub("paused")
    const executor = build(service)
    const result = await executor.apply({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      decision: { type: "block", reason: "skip me" },
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("block")
  })
})
