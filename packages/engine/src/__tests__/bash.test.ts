import { describe, it, expect, vi, beforeEach } from "vitest"
import { BashExecutor } from "../executors/bash"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}))

import { spawn } from "child_process"

function mockSpawn(stdout: string, stderr: string, exitCode: number) {
  const proc = {
    stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
      if (event === "data") cb(Buffer.from(stdout))
    }) },
    stderr: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
      if (event === "data") cb(Buffer.from(stderr))
    }) },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === "close") cb(exitCode)
    }),
    kill: vi.fn(),
  }
  vi.mocked(spawn).mockReturnValue(proc as any)
  return proc
}

describe("BashExecutor", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it("runs a simple command successfully", async () => {
    mockSpawn("hello world", "", 0)

    const node: NodeDef = { id: "test1", type: "bash", bash: "echo hello world" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("hello world")
    expect(result.exitCode).toBe(0)
    expect(result.outputs.last_output).toBe("hello world")
  })

  it("handles command failure", async () => {
    mockSpawn("", "error msg", 1)

    const node: NodeDef = { id: "test2", type: "bash", bash: "false" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(1)
  })

  it("substitutes variables", async () => {
    mockSpawn("value_is_foo", "", 0)

    const node: NodeDef = { id: "test3", type: "bash", bash: "echo value_is_$vars.myvar" }
    const pool = new VarPool({ myvar: "foo" })
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(expect.any(String), ["-c", "echo value_is_foo"], expect.anything())
  })

  it("applies vars_update from JSON stdout", async () => {
    mockSpawn(JSON.stringify({ vars_update: { count: 42 } }), "", 0)

    const node: NodeDef = { id: "test4", type: "bash", bash: "echo json" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.outputs.vars_update).toEqual({ count: 42 })
    expect(pool.get("count")).toBe(42)
  })

  it("applies outputs mapping", async () => {
    mockSpawn("result_text", "", 0)

    const node: NodeDef = {
      id: "test5",
      type: "bash",
      bash: "echo result_text",
      outputs: { result: "$last_output", code: "$exit_code" },
    }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.outputs.result).toBe("result_text")
    expect(result.outputs.code).toBe(0)
    expect(pool.get("result")).toBe("result_text")
    expect(pool.get("code")).toBe(0)
  })

  it("handles timeout", async () => {
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(proc as any)

    const node: NodeDef = { id: "test6", type: "bash", bash: "sleep 999", timeout: 1 }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
  })

  it("vars_update __status=failed marks node as failed", async () => {
    mockSpawn(JSON.stringify({ vars_update: { __status: "failed", reason: "test failed" } }), "", 0)

    const node: NodeDef = { id: "test7", type: "bash", bash: "echo json" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    // __status should not leak into pool
    expect(pool.get("__status")).toBeUndefined()
    // other vars should still be written
    expect(pool.get("reason")).toBe("test failed")
  })

  it("vars_update __status only triggers on 'failed' value", async () => {
    mockSpawn(JSON.stringify({ vars_update: { __status: "completed", data: "ok" } }), "", 0)

    const node: NodeDef = { id: "test8", type: "bash", bash: "echo json" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(pool.get("data")).toBe("ok")
  })
})