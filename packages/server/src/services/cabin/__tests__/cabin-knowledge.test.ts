// G4 findings 舱级 scoping（读时派生）：raw origin task-archive:<id> → 任务行
// cabin_id 命中 / repo_group / project_ids 与舱仓库相交；无锚点（patrol）不入舱。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { scopeCabinFindings, clearCabinFindingScopeCache, type CabinFindingTaskRef } from "../cabin-knowledge"
import type { FindingRow } from "../../../db/dao/findings-dao"

const NOW = "2026-11-12T10:00:00.000Z"

let root: string

function writeRaw(name: string, origin: string): void {
  const dir = path.join(root, "raw", "archives")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), `---\norigin: ${origin}\ntitle: t\n---\nbody\n`, "utf-8")
}

function finding(id: string, rawRef: string, extra?: Partial<FindingRow>): FindingRow {
  return {
    id, kind: "contradiction", status: "open", title: `发现 ${id}`,
    detail: "{}", pages: "[]", raw_ref: rawRef, source: "compile",
    created_at: NOW, updated_at: NOW, ...extra,
  }
}

const TASKS: Record<string, CabinFindingTaskRef> = {
  "task-cabin": { cabin_id: "c1", repo_group: "repo-a" },
  "task-repo": { cabin_id: "other", repo_group: "repo-a" },
  "task-proj": { cabin_id: "other", repo_group: "zzz", project_ids: '["repo-b"]' },
  "task-other": { cabin_id: "other", repo_group: "zzz" },
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-knowledge-test-"))
  clearCabinFindingScopeCache()
  writeRaw("f-cabin.md", "task-archive:task-cabin")
  writeRaw("f-repo.md", "task-archive:task-repo")
  writeRaw("f-proj.md", "task-archive:task-proj")
  writeRaw("f-other.md", "task-archive:task-other")
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function scope(findings: FindingRow[]): string[] {
  return scopeCabinFindings(findings, {
    root, cabinId: "c1",
    cabinRepoNames: new Set(["repo-a", "repo-b"]),
    taskById: (id) => TASKS[id],
  }).map((f) => f.id)
}

describe("scopeCabinFindings (G4)", () => {
  it("任务属本舱 → 入舱", () => {
    expect(scope([finding("f1", "archives/f-cabin.md")])).toEqual(["f1"])
  })

  it("任务 repo_group 与舱仓库相交 → 入舱（跨舱同仓）", () => {
    expect(scope([finding("f2", "archives/f-repo.md")])).toEqual(["f2"])
  })

  it("任务 project_ids 与舱仓库相交 → 入舱", () => {
    expect(scope([finding("f3", "archives/f-proj.md")])).toEqual(["f3"])
  })

  it("他舱任务且仓库不相交 → 不入舱", () => {
    expect(scope([finding("f4", "archives/f-other.md")])).toEqual([])
  })

  it("patrol 无 raw 锚点 → 不入舱", () => {
    expect(scope([finding("f5", "", { source: "patrol" })])).toEqual([])
  })

  it("raw_ref 空时回退 detail.raw.path", () => {
    const f = finding("f6", "", { detail: JSON.stringify({ raw: { path: "archives/f-cabin.md" } }) })
    expect(scope([f])).toEqual(["f6"])
  })

  it("raw 文件缺失 / origin 非 task-archive → 不入舱（不炸列表）", () => {
    writeRaw("f-weird.md", "manual-note")
    expect(scope([
      finding("f7", "archives/missing.md"),
      finding("f8", "archives/f-weird.md"),
    ])).toEqual([])
  })

  it("终态 finding 同样按锚点 scoping（status 由调用方过滤）", () => {
    expect(scope([finding("f9", "archives/f-cabin.md", { status: "resolved" })])).toEqual(["f9"])
  })

  it("缓存命中：同 finding 重复读结果一致", () => {
    const f = finding("f10", "archives/f-cabin.md")
    expect(scope([f])).toEqual(["f10"])
    expect(scope([f])).toEqual(["f10"])
  })
})