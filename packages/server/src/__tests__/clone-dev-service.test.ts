// packages/server/src/__tests__/clone-dev-service.test.ts
//
// clone-dev task kind (2026-11-25) — 服务端闭环：
//   setMeta 建档 → verify 三条判据 → complete 硬闸 → install 装包 → uninstall。
// 使用真实文件系统（临时 OCTOPUS_HOME）+ 内存 sqlite，不用 mock。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applySchema } from "../db/schema"
import { CloneDevService } from "../services/tasks/clone-dev-service"
import { clearCloneKitCache } from "../services/agent/clone-kit-registry"

let db: Database.Database
let tmpHome: string
let prevHome: string | undefined
let seq = 0

function insertTask(id: string, spec: Record<string, unknown>, status = "draft"): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, name, status, task_spec, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, "分身任务", status, JSON.stringify(spec), now, now)
}

beforeEach(() => {
  prevHome = process.env.OCTOPUS_HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), `octo-clone-dev-${seq++}-`))
  process.env.OCTOPUS_HOME = tmpHome
  db = new Database(":memory:")
  applySchema(db)
  clearCloneKitCache()
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpHome, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.OCTOPUS_HOME
  else process.env.OCTOPUS_HOME = prevHome
})

function newService(): { svc: CloneDevService; events: string[] } {
  const events: string[] = []
  const svc = new CloneDevService({ db, emitTaskStatus: (_id, status) => events.push(status) })
  return { svc, events }
}

function cloneDevTask(id: string, extra: Record<string, unknown> = {}): void {
  insertTask(id, { format: "v4", kind: "clone-dev", ...extra })
}

describe("CloneDevService", () => {
  it("setMeta 建档：写状态并创建用户分身目录", () => {
    cloneDevTask("t1")
    const { svc } = newService()
    const snap = svc.setMeta("t1", { clone_name: "oncall-eng", display_name: "值班工程师" })
    expect(snap.state.clone_name).toBe("oncall-eng")
    expect(snap.state.mode).toBe("create")
    expect(fs.existsSync(path.join(tmpHome, "agent", "clones", "oncall-eng", "persona.md"))).toBe(true)
  })

  it("代号锁定：第二次换名被拒", () => {
    cloneDevTask("t2")
    const { svc } = newService()
    svc.setMeta("t2", { clone_name: "alpha" })
    expect(() => svc.setMeta("t2", { clone_name: "beta" })).toThrow(/锁定/)
  })

  it("无工具分身：verify 三条全绿并进入 verified", async () => {
    cloneDevTask("t3")
    const { svc } = newService()
    svc.setMeta("t3", { clone_name: "simple", kit_enabled: false })
    const snap = await svc.verify("t3")
    expect(snap.state.verification).toMatchObject({
      tools_called: true,
      boundary_blocked: true,
      identity_switch: true,
    })
    expect(snap.state.stage).toBe("verified")
  })

  it("complete 硬闸：未验证直接结束 → 409", () => {
    cloneDevTask("t4")
    const { svc } = newService()
    svc.setMeta("t4", { clone_name: "noverify" })
    expect(() => svc.completeTask("t4")).toThrow(/验证未通过/)
  })

  it("complete：三条全绿后 draft→ready 并发 awaiting_archive", async () => {
    cloneDevTask("t5")
    const { svc, events } = newService()
    svc.setMeta("t5", { clone_name: "done-one" })
    await svc.verify("t5")
    const snap = svc.completeTask("t5")
    expect(snap.state.complete).toBe(true)
    expect(events).toContain("awaiting_archive")
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get("t5") as { status: string }
    expect(row.status).toBe("ready")
  })

  it("有工具分身：kit 自检全绿 → tools_called=true", async () => {
    cloneDevTask("t6")
    const { svc } = newService()
    svc.setMeta("t6", { clone_name: "kitty", kit_enabled: true, tools: ["ping"] })
    // 装一个最小 kit：一个 ping 工具 + boundary_guard 探针
    const kitDir = path.join(tmpHome, "agent", "clones", "kitty", "kit", "dist", "kitty")
    fs.mkdirSync(kitDir, { recursive: true })
    fs.writeFileSync(
      path.join(kitDir, "index.js"),
      `module.exports = {
        createKitServer: () => ({ name: 'kitty' }),
        tools: ['ping'],
        selfTest: async () => [
          { name: 'ping', ok: true },
          { name: 'boundary_guard', ok: true },
        ],
      }`,
      "utf-8",
    )
    const snap = await svc.verify("t6")
    expect(snap.state.verification?.tools_called).toBe(true)
    expect(snap.state.stage).toBe("verified")
  })

  it("有工具分身：kit 自检失败 → tools_called=false，stage 回到 draft", async () => {
    cloneDevTask("t7")
    const { svc } = newService()
    svc.setMeta("t7", { clone_name: "broken", kit_enabled: true, tools: ["ping"] })
    const kitDir = path.join(tmpHome, "agent", "clones", "broken", "kit", "dist", "broken")
    fs.mkdirSync(kitDir, { recursive: true })
    fs.writeFileSync(
      path.join(kitDir, "index.js"),
      `module.exports = {
        createKitServer: () => ({}),
        selfTest: async () => [{ name: 'ping', ok: false }],
      }`,
      "utf-8",
    )
    const snap = await svc.verify("t7")
    expect(snap.state.verification?.tools_called).toBe(false)
    expect(snap.state.stage).toBe("draft")
    expect(() => svc.completeTask("t7")).toThrow(/验证未通过/)
  })

  it("uninstall：删用户分身目录；内置分身拒绝", () => {
    cloneDevTask("t8")
    const { svc } = newService()
    svc.setMeta("t8", { clone_name: "removeme" })
    expect(fs.existsSync(path.join(tmpHome, "agent", "clones", "removeme"))).toBe(true)
    expect(svc.uninstall("removeme")).toEqual({ ok: true })
    expect(fs.existsSync(path.join(tmpHome, "agent", "clones", "removeme"))).toBe(false)
    expect(() => svc.uninstall("clone-author")).toThrow(/Built-in/)
  })

  it("非 clone-dev 任务被拒", () => {
    insertTask("t9", { format: "v4" })
    const { svc } = newService()
    expect(() => svc.getState("t9")).toThrow(/not a clone-dev task/)
  })
})
