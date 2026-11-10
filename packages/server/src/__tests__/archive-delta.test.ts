// packages/server/src/__tests__/archive-delta.test.ts
//
// 2026-10-31 收尾：放行后现场检查（末轮 end → HEAD 的提交 + dirty 文件）。
// 这是 preflight / 验收终检 / 归档素材三处共用的唯一口径，单独钉住。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  defaultRun,
  dirtyFingerprint,
  inspectProjectDelta,
  type CommandRunner,
  type ProjectDelta,
} from "../services/tasks/archive-delta"

let tmp: string
let wt: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archive-delta-"))
  wt = path.join(tmp, "projects", "api")
  fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ repos: [{ name: "api", worktree_path: wt }] }),
    "utf-8",
  )
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const fakeRun = (dirty = " M src/a.ts\n"): CommandRunner => (cmd, args) => {
  if (cmd !== "git") return { code: 1, stdout: "", stderr: "unknown command" }
  const sub = args[0]
  if (sub === "rev-parse") return { code: 0, stdout: "bbbbbbbb\n", stderr: "" }
  if (sub === "status") return { code: 0, stdout: dirty, stderr: "" }
  if (sub === "rev-list") return { code: 0, stdout: "2\n", stderr: "" }
  if (sub === "log") return { code: 0, stdout: "[quick-edit] 收紧校验\nchore: 收尾\n", stderr: "" }
  return { code: 0, stdout: "", stderr: "" }
}

describe("inspectProjectDelta", () => {
  it("reads HEAD, dirty files and post-round commits from the worktree", async () => {
    const d = await inspectProjectDelta("api", tmp, "aaaaaaaa", fakeRun())
    expect(d).toMatchObject({
      project: "api",
      dir: wt,
      from: "aaaaaaaa",
      head: "bbbbbbbb",
      commits: 2,
      subjects: ["[quick-edit] 收紧校验", "chore: 收尾"],
      dirty_files: [" M src/a.ts"],
    })
  })

  it("clean worktree → empty dirty list, still reports commits", async () => {
    const d = await inspectProjectDelta("api", tmp, "aaaaaaaa", fakeRun("\n"))
    expect(d.dirty_files).toEqual([])
    expect(d.commits).toBe(2)
  })

  it("missing worktree is honest (error, no head), never throws", async () => {
    const d = await inspectProjectDelta("ghost", tmp, null, fakeRun())
    expect(d.dir).toBeNull()
    expect(d.head).toBeNull()
    expect(d.error).toContain("worktree")
  })
})

describe("defaultRun — 子进程期间事件循环必须在转（2026-11-10 归档假断线事故）", () => {
  // 用户归档时 Web 弹「后端服务未连接 localhost:3001 · 已重试 2 次」：5 个
  // project 的 git push 走 spawnSync，把 Node 事件循环整个钉死，探活 4s 超时
  // 连吃两次。这里钉住生产 runner 的契约 —— 子进程在跑，定时器/HTTP 照常调度。
  it("同步等待会饿死定时器；async spawn 必须让心跳照常跳", async () => {
    let ticks = 0
    const heartbeat = setInterval(() => {
      ticks += 1
    }, 20)
    try {
      // 子进程空转 400ms（模拟 git push 的网络往返）。
      const r = await defaultRun(process.execPath, ["-e", "setTimeout(() => {}, 400)"], process.cwd())
      expect(r.code).toBe(0)
    } finally {
      clearInterval(heartbeat)
    }
    // spawnSync 下 ticks 恒为 0；async 下 ~400ms / 20ms 至少也有十几次。
    expect(ticks).toBeGreaterThanOrEqual(3)
  })
})

describe("dirtyFingerprint", () => {
  const pd = (over: Partial<ProjectDelta> = {}): ProjectDelta => ({
    project: "api",
    dir: "C:/wt",
    from: "a",
    head: "b",
    commits: 1,
    subjects: [],
    dirty_files: [" M a.ts", "?? b.ts"],
    ...over,
  })

  it("is stable across line order and ignores clean projects", () => {
    const a = dirtyFingerprint([pd(), pd({ project: "web", dirty_files: [] })])
    const b = dirtyFingerprint([pd({ dirty_files: ["?? b.ts", " M a.ts"] })])
    expect(a).toBe(b)
  })

  it("changes when a new dirty file appears (decision must be re-asked)", () => {
    const before = dirtyFingerprint([pd()])
    const after = dirtyFingerprint([pd({ dirty_files: [" M a.ts", "?? b.ts", "?? c.ts"] })])
    expect(after).not.toBe(before)
  })
})
