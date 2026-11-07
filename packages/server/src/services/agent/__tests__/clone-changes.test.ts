import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  appendCloneChange,
  readCloneChanges,
  readCloneChangesSince,
  trimOldest,
  textDelta,
  cloneChangesPath,
  CLONE_CHANGES_MAX_BYTES,
} from "../clone-changes"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "octo-clone-changes-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("分身资产变更台账（CHANGES.jsonl）", () => {
  it("追加后按写入顺序读回，坏行跳过", () => {
    appendCloneChange(dir, { ts: "2026-11-07T01:00:00.000Z", kind: "memory", path: "memory/long-term.md", delta_chars: 42 })
    appendCloneChange(dir, { ts: "2026-11-07T02:00:00.000Z", kind: "file", path: "persona.md", delta_lines: 3 })

    fs.appendFileSync(cloneChangesPath(dir), "{not json}\n", "utf-8")

    const entries = readCloneChanges(dir)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: "memory", delta_chars: 42 })
    expect(entries[1]).toMatchObject({ kind: "file", delta_lines: 3 })
  })

  it("按时间窗过滤（只留当天）", () => {
    appendCloneChange(dir, { ts: "2026-11-06T20:00:00.000Z", kind: "file", path: "old.md" })
    appendCloneChange(dir, { ts: "2026-11-07T01:00:00.000Z", kind: "file", path: "new.md" })

    const since = Date.parse("2026-11-07T00:00:00.000Z")
    expect(readCloneChangesSince(dir, since).map((e) => e.path)).toEqual(["new.md"])
  })

  it("超过上限时 FIFO 丢最旧的，保留最新一行", () => {
    const line = JSON.stringify({ ts: "2026-11-07T00:00:00.000Z", kind: "file", path: "x".repeat(200) })
    const content = Array.from({ length: 50 }, () => `${line}\n`).join("")
    const trimmed = trimOldest(content, 1000)

    expect(Buffer.byteLength(trimmed, "utf-8")).toBeLessThanOrEqual(1000)
    expect(trimmed.split("\n").filter(Boolean).length).toBeLessThan(50)
    expect(trimmed.trim().split("\n").at(-1)).toBe(line)
  })

  it("追加超过上限会自动截断，文件不会无界增长", () => {
    const entry = { ts: "2026-11-07T00:00:00.000Z", kind: "file" as const, path: "p".repeat(200) }
    for (let i = 0; i < 2000; i++) appendCloneChange(dir, entry)

    const size = fs.statSync(cloneChangesPath(dir)).size
    expect(size).toBeLessThanOrEqual(CLONE_CHANGES_MAX_BYTES)
    expect(readCloneChanges(dir).length).toBeGreaterThan(0)
  })

  it("textDelta 给出字符/行增量，新建文件以 0 为基线", () => {
    expect(textDelta(null, "a\nb\n")).toEqual({ delta_chars: 4, delta_lines: 2 })
    expect(textDelta("a\n", "a\nb\n")).toEqual({ delta_chars: 2, delta_lines: 1 })
    expect(textDelta("a\nb\n", "a\n")).toEqual({ delta_chars: -2, delta_lines: -1 })
  })
})