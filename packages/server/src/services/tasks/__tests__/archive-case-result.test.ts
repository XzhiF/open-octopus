// packages/server/src/services/tasks/__tests__/archive-case-result.test.ts
//
// 归档判例回执（2026-11-03 归档台 v2）：case-archive 队列执行体里的
// 「新建 / 并档 / 失败」结果落 {task home}/archive/case-result.json，
// 归档窗口「知识落点」据此展示。本测只钉追加/去重/上限/损坏容忍契约。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  archiveCaseResultPath,
  readArchiveCaseResults,
  upsertArchiveCaseResult,
  type ArchiveCaseResult,
} from "../archive-case-result"

let tmpRoot: string
let home: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa-case-result-"))
  home = path.join(tmpRoot, "task-home")
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function record(overrides: Partial<ArchiveCaseResult> = {}): ArchiveCaseResult {
  return {
    queue_task_id: "caw-t1-01",
    action: "created",
    symptom: "登录接口 500：cookie 未清",
    case_path: "cases/2026-11-03-case-abc.md",
    occurrences_before: 0,
    occurrences_after: 1,
    finished_at: "2026-11-03T06:48:42.000Z",
    ...overrides,
  }
}

describe("archive/case-result.json — 判例入档回执", () => {
  it("追加新建 / 并档记录，按写入顺序读回；原子写不残留 .tmp", () => {
    upsertArchiveCaseResult(home, record())
    upsertArchiveCaseResult(home, record({
      queue_task_id: "caw-t1-02",
      action: "merged",
      occurrences_before: 1,
      occurrences_after: 2,
      finished_at: "2026-11-03T06:49:00.000Z",
    }))

    const read = readArchiveCaseResults(home)
    expect(read).toHaveLength(2)
    expect(read[0]).toMatchObject({ action: "created", occurrences_before: 0, occurrences_after: 1 })
    expect(read[1]).toMatchObject({ action: "merged", occurrences_before: 1, occurrences_after: 2 })
    expect(fs.readdirSync(path.join(home, "archive"))).toEqual(["case-result.json"])
  })

  it("同一队列任务重放 ⇒ 覆盖旧记录（失败后重试不留矛盾的两条）", () => {
    upsertArchiveCaseResult(home, record({ action: "failed", case_path: null, occurrences_before: null, occurrences_after: null, error: { code: "LINT_FAIL", message: "boom" } }))
    upsertArchiveCaseResult(home, record({ action: "created" }))

    const read = readArchiveCaseResults(home)
    expect(read).toHaveLength(1)
    expect(read[0].action).toBe("created")
    expect(read[0].error).toBeUndefined()
  })

  it("失败记录带稳定 code/message，case_path 诚实为 null", () => {
    upsertArchiveCaseResult(home, record({
      action: "failed",
      case_path: null,
      occurrences_before: null,
      occurrences_after: null,
      error: { code: "CASE_ARCHIVE_FAILED", message: "wiki lock held" },
    }))
    const [read] = readArchiveCaseResults(home)
    expect(read).toMatchObject({
      action: "failed",
      case_path: null,
      error: { code: "CASE_ARCHIVE_FAILED", message: "wiki lock held" },
    })
  })

  it("最多保留最近 50 条（超上限丢最老）", () => {
    for (let i = 0; i < 55; i++) {
      upsertArchiveCaseResult(home, record({
        queue_task_id: `caw-t1-${String(i).padStart(2, "0")}`,
        finished_at: `2026-11-03T06:${String(i).padStart(2, "0")}:00.000Z`,
      }))
    }
    const read = readArchiveCaseResults(home)
    expect(read).toHaveLength(50)
    expect(read[0].queue_task_id).toBe("caw-t1-05")
    expect(read[49].queue_task_id).toBe("caw-t1-54")
  })

  it("缺失 / 损坏 / 非数组 / 坏记录 ⇒ 容忍（空数组或逐条丢弃）", () => {
    expect(readArchiveCaseResults(home)).toEqual([])

    fs.mkdirSync(path.join(home, "archive"), { recursive: true })
    fs.writeFileSync(archiveCaseResultPath(home), "{not json", "utf-8")
    expect(readArchiveCaseResults(home)).toEqual([])

    fs.writeFileSync(archiveCaseResultPath(home), JSON.stringify({ not: "array" }), "utf-8")
    expect(readArchiveCaseResults(home)).toEqual([])

    fs.writeFileSync(archiveCaseResultPath(home), JSON.stringify([
      record(),
      { queue_task_id: "bad", action: "unknown", symptom: "x" },
      { action: "created", symptom: "no-id" },
    ]), "utf-8")
    expect(readArchiveCaseResults(home)).toHaveLength(1)
  })
})
