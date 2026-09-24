// BashConfig.onSpawn（2026-09-24，测试实例注册表的前置）：spawn 成功后透出
// shell PID 一次，供平台侧记账（进程树根）。真 spawn、跨平台。
import { describe, it, expect } from "vitest"
import { BashExecutor } from "../executors/bash"
import { VarPool } from "@octopus/shared"
import type { NodeDef } from "@octopus/shared"

describe("BashExecutor onSpawn", () => {
  it("fires once with a positive shell PID after spawn", async () => {
    const pids: number[] = []
    const node: NodeDef = { id: "onspawn-1", type: "bash", bash: "echo hi", timeout: 30 }
    const r = await new BashExecutor(node, new VarPool(), {
      onSpawn: (pid) => { pids.push(pid) },
    }).execute()
    expect(r.status).toBe("completed")
    expect(pids).toHaveLength(1)
    expect(pids[0]).toBeGreaterThan(0)
  })

  it("is optional — omitting it keeps behavior unchanged", async () => {
    const node: NodeDef = { id: "onspawn-2", type: "bash", bash: "echo hi", timeout: 30 }
    const r = await new BashExecutor(node, new VarPool()).execute()
    expect(r.status).toBe("completed")
    expect(r.lastOutput).toBe("hi")
  })
})
