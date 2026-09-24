// port-utils 增补（2026-09-24 实例回收功能）：父链反查 + URL 端口解析。
// findParentPid 真调系统工具（netstat/ps/CIM 同款"真命令不 mock"纪律）。
import { describe, it, expect } from "vitest"
import { findParentPid, processAncestry, portFromUrl } from "../port-utils"

describe("findParentPid", () => {
  it("resolves a positive parent for the running vitest process", () => {
    const ppid = findParentPid(process.pid)
    expect(ppid).not.toBeNull()
    expect(ppid!).toBeGreaterThan(0)
    expect(ppid).not.toBe(process.pid)
  })

  it("returns null for dead / invalid pids", () => {
    expect(findParentPid(2 ** 30)).toBeNull()
    expect(findParentPid(-1)).toBeNull()
    expect(findParentPid(NaN)).toBeNull()
    expect(findParentPid(1.5)).toBeNull()
  })
})

describe("processAncestry", () => {
  it("starts with self and walks at least one hop up", () => {
    const chain = processAncestry(process.pid)
    expect(chain[0]).toBe(process.pid)
    expect(chain.length).toBeGreaterThanOrEqual(2)
    expect(new Set(chain).size).toBe(chain.length) // no cycles
  }, 20_000) // one PowerShell/CIM exec on Windows — budget it
})

describe("portFromUrl", () => {
  it("parses explicit ports", () => {
    expect(portFromUrl("http://localhost:3888/")).toBe(3888)
    expect(portFromUrl("http://127.0.0.1:3889")).toBe(3889)
  })
  it("maps scheme defaults", () => {
    expect(portFromUrl("http://example.com")).toBe(80)
    expect(portFromUrl("https://example.com")).toBe(443)
  })
  it("returns null on garbage", () => {
    expect(portFromUrl("not a url")).toBeNull()
    expect(portFromUrl("ftp://x")).toBeNull()
  })
})
