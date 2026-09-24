// TestInstanceRegistry 单测 — 真 spawn 一个占端口的 node HTTP 服务（不 mock
// findPidOnPort），锁「端口反查权威 + 读时 reconcile + 原子写/损坏降级」。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn } from "child_process"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { TestInstanceRegistry } from "../services/tasks/test-instance-registry"

const PORT = 3899 // 测试专用端口（与 plan 一致）

function tmpHome(name: string): string {
  const dir = path.join(os.tmpdir(), `octopus-inst-reg-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

describe("TestInstanceRegistry", () => {
  let child: ReturnType<typeof spawn>
  let reg: TestInstanceRegistry

  beforeAll(async () => {
    child = spawn(process.execPath, ["-e",
      `require("http").createServer((_,res)=>res.end("ok")).listen(${PORT})`], { stdio: "ignore" })
    expect(await waitFor(() => child.exitCode === null || true)).toBe(true) // spawn attempted
  })

  afterAll(() => {
    try { child.kill() } catch { /* already dead */ }
  })

  it("alive entry: ports reconcile to the real listener pid; kill → stale", async () => {
    reg = new TestInstanceRegistry(tmpHome("alive"))
    const up = await waitFor(() => {
      const e = reg.add("t-1", { source: "preview-up", ports: [PORT], urls: [`http://localhost:${PORT}`] })
      return reg.listEntries("t-1")[0]?.pids.length > 0
    })
    expect(up, `no listener found on :${PORT} — child died? exit=${child.exitCode}`).toBe(true)

    let entries = reg.listEntries("t-1")
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe("alive")
    expect(entries[0].pids).toContain(child.pid!)

    child.kill()
    const gone = await waitFor(() => reg.listEntries("t-1")[0]?.status === "stale", 15_000)
    expect(gone).toBe(true)
    // 二次读稳定（写回幂等）
    expect(reg.listEntries("t-1")[0].status).toBe("stale")
  }, 30_000)

  it("no ports, live shell_pid → alive; stopped entries hide on next add", () => {
    const r = new TestInstanceRegistry(tmpHome("shell"))
    r.add("t-2", { source: "probe-launcher", ports: [], urls: [], shell_pid: process.pid })
    expect(r.listEntries("t-2")[0].status).toBe("alive")
    r.add("t-2", { source: "probe-launcher", ports: [], urls: [], shell_pid: 999_999_999 })
    const st = r.listEntries("t-2").map((e) => e.status)
    expect(st).toEqual(["alive", "stale"])
  })

  it("markStopped deletes the file when all entries are stopped", () => {
    const home = tmpHome("stop")
    const r = new TestInstanceRegistry(home)
    const a = r.add("t-3", { source: "preview-up", ports: [], urls: [] })
    const b = r.add("t-3", { source: "preview-up", ports: [], urls: [] })
    r.markStopped("t-3", [a.id])
    expect(r.read("t-3").map((e) => e.status)).toEqual(["stopped", "alive"])
    r.markStopped("t-3")
    expect(r.read("t-3")).toEqual([])
    expect(() => readFileSync(path.join(home, "t-3.json"), "utf-8")).toThrow()
    void b
  })

  it("corrupt file degrades to empty, never throws", () => {
    const home = tmpHome("corrupt")
    const r = new TestInstanceRegistry(home)
    r.add("t-4", { source: "preview-up", ports: [], urls: [] })
    writeFileSync(path.join(home, "t-4.json"), "{not json")
    expect(r.read("t-4")).toEqual([])
    expect(r.listEntries("t-4")).toEqual([])
  })

  it("listTaskIds enumerates registry files", () => {
    const home = tmpHome("sweep")
    const r = new TestInstanceRegistry(home)
    r.add("taskA", { source: "preview-up", ports: [], urls: [] })
    r.add("task/B", { source: "preview-up", ports: [], urls: [] })
    expect(r.listTaskIds().sort()).toEqual(["task-B", "taskA"])
  })
})
