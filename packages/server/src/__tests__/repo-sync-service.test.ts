// repo-sync-service.test.ts — 镜像同步状态机单测（全 stub，不碰真 git/网络）。
//
// 覆盖：并发去重（同仓两任务一次 sync）/ 解析失败即 failed 快照+SSE /
// 完成后逐 watcher 各发 ok 事件 / waitUntilIdle 完成即返 + 超时放行 /
// freshnessLine 三态 / 重启（新实例）hasSnapshot=false / forget。

import { describe, it, expect, vi } from "vitest"
import { RepoSyncService, type ProjectSyncSnapshot } from "../services/tasks/repo-sync-service"

interface Emitted {
  channel: string
  event: string
  data: { task_id: string; project: string; status: string; branch?: string; commit?: string; error?: string }
}

function makeService(opts: {
  paths?: Record<string, string>            // "org::name" → path（缺省 throw）
  syncImpl?: (repoPath: string) => Promise<{ branch: string; commit: string }>
} = {}) {
  const emits: Emitted[] = []
  const svc = new RepoSyncService({
    sse: { emit: (channel, payload) => emits.push({ channel, event: payload.event, data: payload.data as Emitted["data"] }) },
    resolve: (org, name) => {
      const p = opts.paths?.[`${org}::${name}`]
      if (!p) throw new Error(`repo '${name}' not found in index.md for org '${org}'`)
      return p
    },
    sync: opts.syncImpl ?? (async () => ({ branch: "main", commit: "abc12345" })),
  })
  return { svc, emits }
}

const PATHS = { "xzf::open-octopus": "/repos/open-octopus", "xzf::other": "/repos/other" }

describe("RepoSyncService", () => {
  it("同仓两任务并发 → 只跑一次 sync，各拿各的 ok 事件", async () => {
    let calls = 0
    let release: (v: { branch: string; commit: string }) => void = () => {}
    const { svc, emits } = makeService({
      paths: PATHS,
      syncImpl: () => {
        calls += 1
        return new Promise((res) => { release = res })
      },
    })

    svc.syncProjectsForTask("task-A", "xzf", ["open-octopus"])
    svc.syncProjectsForTask("task-B", "xzf", ["open-octopus"])
    expect(svc.isBusy("task-A") && svc.isBusy("task-B")).toBe(true)

    release({ branch: "main", commit: "deadbeef" })
    await vi.waitFor(() => {
      expect(svc.isBusy("task-A")).toBe(false)
      expect(svc.isBusy("task-B")).toBe(false)
    })
    expect(calls).toBe(1)

    const oks = emits.filter((e) => e.data.status === "ok")
    expect(oks.map((e) => e.data.task_id).sort()).toEqual(["task-A", "task-B"])
    for (const o of oks) {
      expect(o.channel).toBe("taskpool")
      expect(o.event).toBe("project_sync")
      expect(o.data).toMatchObject({ project: "open-octopus", branch: "main", commit: "deadbeef" })
    }
  })

  it("解析失败 → failed 快照 + project_sync{failed}，不 sync", async () => {
    const syncImpl = vi.fn(async () => ({ branch: "main", commit: "x" }))
    const { svc, emits } = makeService({ paths: {}, syncImpl })
    svc.syncProjectsForTask("t1", "xzf", ["ghost-repo"])

    expect(svc.isBusy("t1")).toBe(false)
    const fail = emits.find((e) => e.data.status === "failed")
    expect(fail?.data).toMatchObject({ task_id: "t1", project: "ghost-repo" })
    expect(fail?.data.error).toMatch(/not found in index\.md/)
    expect(syncImpl).not.toHaveBeenCalled()
  })

  it("sync 抛错 → 全体 watcher failed 快照", async () => {
    const { svc, emits } = makeService({
      paths: PATHS,
      syncImpl: async () => { throw new Error("network down") },
    })
    svc.syncProjectsForTask("t1", "xzf", ["open-octopus"])
    await vi.waitFor(() => expect(svc.isBusy("t1")).toBe(false))
    const fail = emits.filter((e) => e.data.status === "failed").at(-1)
    expect(fail?.data.error).toContain("network down")
    expect(svc.freshnessLine("t1", "open-octopus")).toBe("⚠ 同步失败: network down（代码可能过期）")
  })

  it("waitUntilIdle：完成即返回（远小于超时）", async () => {
    let release: (v: { branch: string; commit: string }) => void = () => {}
    const { svc } = makeService({
      paths: PATHS,
      syncImpl: () => new Promise((res) => { release = res }),
    })
    svc.syncProjectsForTask("t1", "xzf", ["open-octopus"])
    const started = Date.now()
    setTimeout(() => release({ branch: "main", commit: "c0ffee00" }), 100)
    await svc.waitUntilIdle("t1", 5_000)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(svc.freshnessLine("t1", "open-octopus")).toBe("[main @c0ffee00 · 已同步 ✓]")
  })

  it("waitUntilIdle：超时放行不抛，快照仍 syncing", async () => {
    const { svc } = makeService({
      paths: PATHS,
      syncImpl: () => new Promise(() => {}), // 永挂
    })
    svc.syncProjectsForTask("t1", "xzf", ["open-octopus"])
    await expect(svc.waitUntilIdle("t1", 400)).resolves.toBeUndefined()
    expect(svc.freshnessLine("t1", "open-octopus")).toBe("⚠ 同步未完成，代码可能过期")
  })

  it("freshnessNotes 只含有快照的项目；无快照任务 → undefined", async () => {
    const { svc } = makeService({ paths: PATHS })
    expect(svc.freshnessNotes("t0", ["open-octopus"])).toBeUndefined()
    svc.syncProjectsForTask("t1", "xzf", ["open-octopus"])
    await vi.waitFor(() => expect(svc.isBusy("t1")).toBe(false))
    expect(svc.freshnessNotes("t1", ["open-octopus", "no-record"])).toEqual({
      "open-octopus": "[main @abc12345 · 已同步 ✓]",
    })
  })

  it("forget 回收；新实例（模拟重启）hasSnapshot=false", async () => {
    const { svc } = makeService({ paths: PATHS })
    svc.syncProjectsForTask("t1", "xzf", ["open-octopus"])
    await vi.waitFor(() => expect(svc.isBusy("t1")).toBe(false))
    expect(svc.hasSnapshot("t1")).toBe(true)

    svc.forget("t1")
    expect(svc.hasSnapshot("t1")).toBe(false)

    const { svc: fresh } = makeService({ paths: PATHS })
    expect(fresh.hasSnapshot("t1")).toBe(false)
    expect(fresh.isBusy("t1")).toBe(false)
  })

  it("快照类型自检（ProjectSyncSnapshot 形状）", () => {
    const s: ProjectSyncSnapshot = { project: "p", status: "ok", branch: "main", commit: "abc", syncedAt: new Date().toISOString() }
    expect(s.status).toBe("ok")
  })
})
