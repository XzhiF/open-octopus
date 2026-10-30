// packages/server/src/__tests__/acceptance-guard.test.ts
//
// 验收引导小修护栏（2026-10-30 AI-native 验收）：
//   · 批次目录 .scratch 仍被 doer 护栏拒绝（计划回写走 REST）；
//   · 每次引导最多改 maxFiles 个不同文件（第三个写目标被拒并提示升级大修复）；
//   · 同一个文件反复编辑不重复计数。

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { buildAcceptanceGuard } from "../services/agent/clone-runtime"

const ws = path.join(os.tmpdir(), `octopus-acceptance-guard-${Date.now()}`)

beforeAll(() => {
  fs.mkdirSync(path.join(ws, "projects", "app"), { recursive: true })
  fs.mkdirSync(path.join(ws, ".scratch", "batch"), { recursive: true })
})
afterAll(() => {
  try { fs.rmSync(ws, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const write = (file: string) => ({ file_path: file })

describe("buildAcceptanceGuard", () => {
  it("allows writes up to the budget, counting each file once", async () => {
    const guard = buildAcceptanceGuard(ws, "task-1", { maxFiles: 2 })
    const a = path.join(ws, "projects", "app", "a.ts")
    const b = path.join(ws, "projects", "app", "b.ts")
    expect(await guard("Write", write(a))).toBeUndefined()
    expect(await guard("Edit", write(a))).toBeUndefined() // same file — no extra budget
    expect(await guard("Write", write(b))).toBeUndefined()
  })

  it("refuses the third distinct file and points at the escalation path", async () => {
    const guard = buildAcceptanceGuard(ws, "task-2", { maxFiles: 2 })
    const dir = path.join(ws, "projects", "app")
    await guard("Write", write(path.join(dir, "1.ts")))
    await guard("Write", write(path.join(dir, "2.ts")))
    const denied = await guard("Write", write(path.join(dir, "3.ts")))
    expect(denied?.allow).toBe(false)
    expect(denied?.reason).toContain("小修边界")
    expect(denied?.reason).toContain("propose_acceptance_escalation")
  })

  it("keeps the doer batch-dir fence (plans go through the REST channel)", async () => {
    const guard = buildAcceptanceGuard(ws, "task-3", { maxFiles: 2 })
    const denied = await guard("Write", write(path.join(ws, ".scratch", "batch", "spec.md")))
    expect(denied?.allow).toBe(false)
    expect(denied?.reason).toContain("批次目录")
  })

  it("never blocks read-only tools", async () => {
    const guard = buildAcceptanceGuard(ws, "task-4", { maxFiles: 2 })
    expect(await guard("Read", { file_path: path.join(ws, "projects", "app", "a.ts") })).toBeUndefined()
    expect(await guard("Grep", { pattern: "x" })).toBeUndefined()
  })
})
