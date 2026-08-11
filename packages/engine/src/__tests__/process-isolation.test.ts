import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"
import {
  buildHostEnv,
  prependWrapper,
  HARNESS_WRAPPER,
  killProcessTree,
  startForceKillChain,
} from "../executors/process-isolation"

// Mock child_process for both executors and process-isolation module
vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}))

import { spawn, execSync } from "child_process"

function createMockSpawn(stdout = "", stderr = "", exitCode = 0) {
  const listeners: Record<string, Array<(...args: any[]) => void>> = {}
  const proc = {
    pid: 12345,
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") {
          if (!listeners["stdout:data"]) listeners["stdout:data"] = []
          listeners["stdout:data"].push(cb)
          // Emit immediately for simple tests
          cb(Buffer.from(stdout))
        }
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") {
          if (!listeners["stderr:data"]) listeners["stderr:data"] = []
          listeners["stderr:data"].push(cb)
          cb(Buffer.from(stderr))
        }
      }),
    },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      if (event === "close") cb(exitCode)
    }),
    kill: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.mocked(spawn).mockReturnValue(proc as any)
  return { proc, listeners }
}

// ============================================================
// Unit tests: process-isolation module
// ============================================================

describe("buildHostEnv", () => {
  const originalPid = process.pid
  const originalPort = process.env.PORT

  afterEach(() => {
    // Restore PORT
    if (originalPort !== undefined) {
      process.env.PORT = originalPort
    } else {
      delete process.env.PORT
    }
  })

  it("injects OCTOPUS_HOST_PID with current process PID", () => {
    const env = buildHostEnv()
    expect(env.OCTOPUS_HOST_PID).toBe(String(process.pid))
  })

  it("injects OCTOPUS_HOST_PORTS with serverPort,webPort", () => {
    process.env.PORT = "4001"
    const env = buildHostEnv()
    expect(env.OCTOPUS_HOST_PORTS).toBe("4001,4000")
  })

  it("defaults to 3001,3000 when PORT is not set", () => {
    delete process.env.PORT
    const env = buildHostEnv()
    expect(env.OCTOPUS_HOST_PORTS).toBe("3001,3000")
  })

  it("removes OCTOPUS_DB_PATH from child env", () => {
    process.env.OCTOPUS_DB_PATH = "/some/path/db.sqlite"
    const env = buildHostEnv()
    expect(env.OCTOPUS_DB_PATH).toBeUndefined()
    delete process.env.OCTOPUS_DB_PATH
  })
})

describe("prependWrapper", () => {
  it("prepends HARNESS SAFETY WRAPPER before user script", () => {
    const script = "echo hello"
    const result = prependWrapper(script)
    expect(result).toContain("# --- HARNESS SAFETY WRAPPER ---")
    expect(result).toContain("# --- END HARNESS WRAPPER ---")
    expect(result.endsWith("echo hello")).toBe(true)
  })

  it("includes safe_kill function", () => {
    const result = prependWrapper("true")
    expect(result).toContain("safe_kill()")
    expect(result).toContain("BLOCKED: Cannot kill host process")
  })

  it("includes safe_pkill function", () => {
    const result = prependWrapper("true")
    expect(result).toContain("safe_pkill()")
    expect(result).toContain("pkill is restricted")
  })

  it("enables alias expansion with shopt", () => {
    const result = prependWrapper("true")
    expect(result).toContain("shopt -s expand_aliases")
  })

  it("aliases kill and pkill to safe versions", () => {
    const result = prependWrapper("true")
    expect(result).toContain("alias kill='safe_kill'")
    expect(result).toContain("alias pkill='safe_pkill'")
  })
})

describe("killProcessTree", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset()
  })

  it("uses taskkill on Windows", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "win32" })

    killProcessTree(9999)
    expect(execSync).toHaveBeenCalledWith(
      "taskkill /PID 9999 /T /F",
      { stdio: "ignore" },
    )

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("uses process group kill on Unix", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
    killProcessTree(9999, "SIGTERM")

    expect(killSpy).toHaveBeenCalledWith(-9999, "SIGTERM")
    killSpy.mockRestore()

    Object.defineProperty(process, "platform", { value: originalPlatform })
  })
})

describe("startForceKillChain", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(execSync).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("sends SIGTERM immediately", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    startForceKillChain(8888, 5000)

    expect(killSpy).toHaveBeenCalledWith(-8888, "SIGTERM")
    killSpy.mockRestore()
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("sends SIGKILL after grace period", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    startForceKillChain(8888, 5000)
    killSpy.mockClear()

    vi.advanceTimersByTime(5000)

    expect(killSpy).toHaveBeenCalledWith(-8888, "SIGKILL")
    killSpy.mockRestore()
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })

  it("cancel prevents SIGKILL", () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    const chain = startForceKillChain(8888, 5000)
    killSpy.mockClear()

    chain.cancel()
    vi.advanceTimersByTime(10000)

    expect(killSpy).not.toHaveBeenCalled()
    killSpy.mockRestore()
    Object.defineProperty(process, "platform", { value: originalPlatform })
  })
})

// ============================================================
// Integration tests: BashExecutor uses process isolation
// ============================================================

describe("BashExecutor — process isolation", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it("injects OCTOPUS_HOST_PID and OCTOPUS_HOST_PORTS into child env", async () => {
    createMockSpawn("ok", "", 0)

    const { BashExecutor } = await import("../executors/bash")
    const node: NodeDef = { id: "t1", type: "bash", bash: "echo ok" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    await executor.execute()

    const spawnCall = vi.mocked(spawn).mock.calls[0]
    const spawnOpts = spawnCall[2] as any
    expect(spawnOpts.env.OCTOPUS_HOST_PID).toBe(String(process.pid))
    expect(spawnOpts.env.OCTOPUS_HOST_PORTS).toBeDefined()
    expect(spawnOpts.env.OCTOPUS_HOST_PORTS).toMatch(/^\d+,\d+$/)
  })

  it("prepends harness wrapper to user script", async () => {
    createMockSpawn("ok", "", 0)

    const { BashExecutor } = await import("../executors/bash")
    const node: NodeDef = { id: "t2", type: "bash", bash: "echo hello" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    await executor.execute()

    const spawnCall = vi.mocked(spawn).mock.calls[0]
    const scriptArg = (spawnCall[1] as string[])[1] // ["-c", script]
    expect(scriptArg).toContain("# --- HARNESS SAFETY WRAPPER ---")
    expect(scriptArg).toContain("echo hello")
    // Wrapper comes before user script
    const wrapperIdx = scriptArg.indexOf("HARNESS SAFETY WRAPPER")
    const userScriptIdx = scriptArg.indexOf("echo hello")
    expect(wrapperIdx).toBeLessThan(userScriptIdx)
  })

  it("removes OCTOPUS_DB_PATH from child env", async () => {
    process.env.OCTOPUS_DB_PATH = "/some/path"
    createMockSpawn("ok", "", 0)

    const { BashExecutor } = await import("../executors/bash")
    const node: NodeDef = { id: "t3", type: "bash", bash: "true" }
    const pool = new VarPool()
    const executor = new BashExecutor(node, pool)
    await executor.execute()

    const spawnCall = vi.mocked(spawn).mock.calls[0]
    const spawnOpts = spawnCall[2] as any
    expect(spawnOpts.env.OCTOPUS_DB_PATH).toBeUndefined()
    delete process.env.OCTOPUS_DB_PATH
  })
})

// ============================================================
// Integration tests: PythonExecutor uses process isolation
// ============================================================

describe("PythonExecutor — process isolation", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it("injects OCTOPUS_HOST_PID and OCTOPUS_HOST_PORTS into child env", async () => {
    createMockSpawn("42", "", 0)

    const { PythonExecutor } = await import("../executors/python")
    const node: NodeDef = { id: "py1", type: "python", python: "print(42)" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    await executor.execute()

    const spawnCall = vi.mocked(spawn).mock.calls[0]
    const spawnOpts = spawnCall[2] as any
    expect(spawnOpts.env.OCTOPUS_HOST_PID).toBe(String(process.pid))
    expect(spawnOpts.env.OCTOPUS_HOST_PORTS).toMatch(/^\d+,\d+$/)
  })

  it("uses process group kill on timeout instead of proc.kill", async () => {
    vi.useFakeTimers()

    // Create a mock that does NOT close on kill — simulates a hung process
    const listeners: Record<string, Array<(...args: any[]) => void>> = {}
    const proc = {
      pid: 55555,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (!listeners[event]) listeners[event] = []
        listeners[event].push(cb)
        // Don't auto-fire close — simulate hung process
      }),
      kill: vi.fn(),
    }
    vi.mocked(spawn).mockReturnValue(proc as any)

    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux" })
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)

    const { PythonExecutor } = await import("../executors/python")
    const node: NodeDef = { id: "py2", type: "python", python: "while True: pass", timeout: 1 }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)

    const resultPromise = executor.execute()

    // Advance past timeout (1 second)
    vi.advanceTimersByTime(1100)

    // Should have used process group kill (negative PID), NOT proc.kill
    expect(killSpy).toHaveBeenCalledWith(-55555, "SIGTERM")

    // Now simulate process close
    for (const cb of listeners["close"] ?? []) {
      cb(null)
    }

    const result = await resultPromise
    expect(result.status).toBe("failed")

    killSpy.mockRestore()
    Object.defineProperty(process, "platform", { value: originalPlatform })
    vi.useRealTimers()
  })

  it("removes OCTOPUS_DB_PATH from child env", async () => {
    process.env.OCTOPUS_DB_PATH = "/some/path"
    createMockSpawn("ok", "", 0)

    const { PythonExecutor } = await import("../executors/python")
    const node: NodeDef = { id: "py3", type: "python", python: "print('ok')" }
    const pool = new VarPool()
    const executor = new PythonExecutor(node, pool)
    await executor.execute()

    const spawnCall = vi.mocked(spawn).mock.calls[0]
    const spawnOpts = spawnCall[2] as any
    expect(spawnOpts.env.OCTOPUS_DB_PATH).toBeUndefined()
    delete process.env.OCTOPUS_DB_PATH
  })
})
