// packages/server/src/services/tasks/__tests__/branch-plan.test.ts
//
// 分支计划（2026-11-24）解析顺序：
//   任务显式（branch_plan[repo] > base_branch/target_branch）
//   > 舱绑定（config.repos[].mainline_branch）
//   > null（调用方补仓库默认分支）
// target 缺省跟随 base（允许不同，默认同值）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import { resolveBranchOverrides, fillTarget, cabinMainlineBranch } from "../branch-plan"

const CABIN_ID = "cabin-branch-plan"

let db: Database.Database
let home: string
let cabinPath: string

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  home = fs.mkdtempSync(path.join(os.tmpdir(), "branch-plan-"))
  cabinPath = path.join(home, "cabin")
  fs.mkdirSync(cabinPath, { recursive: true })
  db.prepare(
    "INSERT INTO cabins (id, name, path, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(CABIN_ID, "cabin", cabinPath, "active", "2026-11-24T00:00:00Z", "2026-11-24T00:00:00Z")
})

afterEach(() => {
  db.close()
  fs.rmSync(home, { recursive: true, force: true })
})

function writeCabinRepos(repos: unknown[]): void {
  fs.mkdirSync(path.join(cabinPath, ".octopus"), { recursive: true })
  fs.writeFileSync(
    path.join(cabinPath, ".octopus", "config.json"),
    JSON.stringify({ name: "cabin", repos }),
  )
}

const task = (spec: Record<string, unknown>, cabinId: string | null = CABIN_ID) => ({
  cabin_id: cabinId,
  task_spec: JSON.stringify(spec),
})

describe("resolveBranchOverrides — 任务显式 > 舱绑定 > null", () => {
  it("任务级 base_branch / target_branch 覆盖舱 mainline_branch", () => {
    writeCabinRepos([{ name: "console", mainline_branch: "feat/cabin" }])
    const plan = resolveBranchOverrides(
      db,
      task({ base_branch: "feat/task", target_branch: "release" }),
      "console",
    )
    expect(plan).toEqual({ base: "feat/task", target: "release", source: "task" })
  })

  it("per-repo branch_plan 优先于任务级默认", () => {
    writeCabinRepos([{ name: "console", mainline_branch: "feat/cabin" }])
    const plan = resolveBranchOverrides(
      db,
      task({
        base_branch: "feat/all",
        target_branch: "feat/all",
        branch_plan: { console: { base: "feat/console-only" } },
      }),
      "console",
    )
    expect(plan).toMatchObject({ base: "feat/console-only", target: "feat/all", source: "task" })
  })

  it("任务没写 → 用舱项目的 mainline_branch（base 与 target 同值）", () => {
    writeCabinRepos([{ name: "console", mainline_branch: "feat/long-lived" }])
    expect(resolveBranchOverrides(db, task({}), "console")).toEqual({
      base: "feat/long-lived",
      target: "feat/long-lived",
      source: "cabin",
    })
  })

  it("舱绑定按 repoName 也能命中（org 原名与舱内别名不同）", () => {
    writeCabinRepos([{ name: "console-alias", repoName: "console", mainline_branch: "feat/x" }])
    expect(cabinMainlineBranch(db, CABIN_ID, "console")).toBe("feat/x")
  })

  it("既无任务显式也无舱绑定 → null（交给仓库默认分支）", () => {
    writeCabinRepos([{ name: "console" }])
    expect(resolveBranchOverrides(db, task({}), "console")).toBeNull()
  })

  it("非舱任务没有 cabin_id → null", () => {
    expect(resolveBranchOverrides(db, task({}, null), "console")).toBeNull()
  })

  it("舱行已软删 / config 缺失 → null（不猜）", () => {
    db.prepare("UPDATE cabins SET deleted_at = ? WHERE id = ?").run("2026-11-24T01:00:00Z", CABIN_ID)
    expect(resolveBranchOverrides(db, task({}), "console")).toBeNull()
  })
})

describe("fillTarget — target 缺省跟随 base", () => {
  it("只有 base → target 同值", () => {
    expect(fillTarget({ base: "feat/x", source: "cabin" })).toEqual({
      base: "feat/x",
      target: "feat/x",
    })
  })

  it("base/target 不同 → 原样保留", () => {
    expect(fillTarget({ base: "feat/x", target: "master", source: "task" })).toEqual({
      base: "feat/x",
      target: "master",
    })
  })

  it("null → 空对象", () => {
    expect(fillTarget(null)).toEqual({})
  })
})
