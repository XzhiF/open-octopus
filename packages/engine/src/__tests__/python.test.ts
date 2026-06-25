import { describe, it, expect, vi, beforeEach } from "vitest"
import { PythonExecutor } from "../executors/python"
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

describe("PythonExecutor", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it("runs a simple python script", async () => {
    mockSpawn("42", "", 0)

    const node: NodeDef = { id: "py1", type: "python", python: "print(42)" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(result.lastOutput).toBe("42")
  })

  it("handles python failure", async () => {
    mockSpawn("", "Traceback", 1)

    const node: NodeDef = { id: "py2", type: "python", python: "raise Exception('fail')" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.exitCode).toBe(1)
  })

  it("applies vars_update from JSON stdout", async () => {
    mockSpawn(JSON.stringify({ vars_update: { result: "done" } }), "", 0)

    const node: NodeDef = { id: "py3", type: "python", python: "import json; print(json.dumps({'vars_update': {'result': 'done'}}))" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(pool.get("result")).toBe("done")
  })

  it("substitutes variables in script", async () => {
    mockSpawn("hello_foo", "", 0)

    const node: NodeDef = { id: "py4", type: "python", python: "print('hello_$vars.name')" }
    const pool = new VarPool({ name: "foo" })
    const executor = new PythonExecutor(node, pool)

    await executor.execute()
    expect(vi.mocked(spawn)).toHaveBeenCalledWith("python3", ["-c", "print('hello_foo')"], expect.anything())
  })

  it("vars_update __status=failed marks node as failed", async () => {
    mockSpawn(JSON.stringify({ vars_update: { __status: "failed", detail: "assertion error" } }), "", 0)

    const node: NodeDef = { id: "py5", type: "python", python: "import json; print(json.dumps(...))" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(pool.get("__status")).toBeUndefined()
    expect(pool.get("detail")).toBe("assertion error")
  })
})