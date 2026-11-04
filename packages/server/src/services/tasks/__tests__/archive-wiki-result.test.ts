// packages/server/src/services/tasks/__tests__/archive-wiki-result.test.ts
//
// 归档 wiki 编译回执（2026-11-03 归档台 v2）：compilePack 结果落
// {task home}/archive/wiki-result.json —— 归档窗口「知识落点」的真相面。
// 本测只钉持久化契约（成功投影 / 失败投影 / 缺失损坏 = null），编译本体由
// wiki-pack-compile / wiki-write-queue 既有测试覆盖。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  archiveWikiResultPath,
  readArchiveWikiResult,
  toArchiveWikiFailure,
  toArchiveWikiResult,
  writeArchiveWikiResult,
} from "../archive-wiki-result"

let tmpRoot: string
let home: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa-wiki-result-"))
  home = path.join(tmpRoot, "task-home")
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const COMPILE_RESULT = {
  rawPath: "raw/archives/task-t1/07-archive-summary.md",
  rawHash: "a".repeat(64),
  rawTitle: "素材包 task-t1",
  touched: [
    { path: "entities/ent-a.md", type: "entities", created: false },
    { path: "topics/top-b.md", type: "topics", created: true },
    { path: "sources/task-t1.md", type: "sources", created: true },
  ],
  created: 2,
  updated: 1,
  contradictions: 1,
  findingIds: ["fnd-1"],
  commit: "5a5a669",
  changed: true,
  deduped: false,
  warnings: ["w1"],
}

describe("archive/wiki-result.json — 编译回执持久化", () => {
  it("成功回执：只投影展示字段（不拷 raw 正文路径以外的编译内部态），原子写入后可读回", () => {
    const started = "2026-11-03T06:46:31.000Z"
    const finished = "2026-11-03T06:48:42.000Z"
    writeArchiveWikiResult(home, toArchiveWikiResult(COMPILE_RESULT, started, finished))

    expect(fs.existsSync(archiveWikiResultPath(home))).toBe(true)
    const read = readArchiveWikiResult(home)!
    expect(read).toMatchObject({
      status: "committed",
      started_at: started,
      finished_at: finished,
      commit: "5a5a669",
      changed: true,
      deduped: false,
      created: 2,
      updated: 1,
      contradictions: 1,
      finding_ids: ["fnd-1"],
      warnings: ["w1"],
    })
    expect(read.touched).toEqual([
      { path: "entities/ent-a.md", type: "entities", created: false },
      { path: "topics/top-b.md", type: "topics", created: true },
      { path: "sources/task-t1.md", type: "sources", created: true },
    ])
    expect(read.error).toBeUndefined()
    // 原子替换：不残留 .tmp
    expect(fs.readdirSync(path.join(home, "archive"))).toEqual(["wiki-result.json"])
  })

  it("失败回执：稳定 code/message（错误前缀去重），零页零 commit —— 素材包保持可重试", () => {
    const err = Object.assign(new Error("LINT_FAIL: 正文含日期"), { code: "LINT_FAIL" })
    const read = toArchiveWikiFailure(err, "2026-11-03T06:46:31.000Z", "2026-11-03T06:48:42.000Z")
    expect(read.status).toBe("failed")
    expect(read.error).toEqual({ code: "LINT_FAIL", message: "正文含日期" })
    expect(read.created).toBe(0)
    expect(read.updated).toBe(0)
    expect(read.touched).toEqual([])
    expect(read.commit).toBeNull()
  })

  it("缺失 / 损坏 / 形状不对 ⇒ null（旧任务诚实缺席，不抛）", () => {
    expect(readArchiveWikiResult(home)).toBeNull()

    fs.mkdirSync(path.join(home, "archive"), { recursive: true })
    fs.writeFileSync(archiveWikiResultPath(home), "{not json", "utf-8")
    expect(readArchiveWikiResult(home)).toBeNull()

    fs.writeFileSync(archiveWikiResultPath(home), JSON.stringify({ status: "unknown" }), "utf-8")
    expect(readArchiveWikiResult(home)).toBeNull()
  })
})
