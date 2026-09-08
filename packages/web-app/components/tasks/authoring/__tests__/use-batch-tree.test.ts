// #53 票 03 — useBatchTree：R1 纯判据 + 四路刷新触发 + 对位/摘要纯函数。
// 计时策略：fake timers 全程；mount fetch 用微任务 flush（mock 立即 resolve），
// debounce 用 advanceTimersByTime + 空 act flush。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  useBatchTree, isScratchWrite, findSpecEntry, findBatchFor, summarizeSpec,
  R1_DEBOUNCE_MS, RETRY_DELAY_MS,
} from "../use-batch-tree"
import { getBatchTree, type BatchTreeEntry } from "@/lib/tasks-api"
import type { ToolCallRecord } from "@/lib/agent/types"

vi.mock("@/lib/tasks-api", () => ({
  getBatchTree: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(() => () => {}),
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

function tc(id: string, name: string, input: unknown, status: string): ToolCallRecord {
  return { id, name, input, status } as ToolCallRecord
}

/** flush 所有已到期的微任务与定时器（advance 后再空 act 让 React 落地）。 */
async function flush(ms = 0) {
  if (ms > 0) vi.advanceTimersByTime(ms)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(getBatchTree).mockReset().mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe("isScratchWrite — R1 判据 (AC1)", () => {
  it("写工具命中 .scratch/（相对/绝对/反斜杠）→ true", () => {
    expect(isScratchWrite("Write", { file_path: ".scratch/20260906/x/spec.md" })).toBe(true)
    expect(isScratchWrite("Edit", { file_path: "C:\\Users\\a\\.octopus\\tasks\\t\\.scratch\\20260906\\x\\spec.md" })).toBe(true)
    expect(isScratchWrite("NotebookEdit", { notebook_path: ".scratch/a/b.ipynb" })).toBe(true)
    expect(isScratchWrite("MultiEdit", { file_path: "./.scratch/d/s/issues/01.md" })).toBe(true)
  })
  it("非 .scratch / 非写工具 / 未开始写 / 畸形 input → false", () => {
    expect(isScratchWrite("Write", { file_path: "artifacts/x.md" })).toBe(false)
    expect(isScratchWrite("Bash", { command: "echo > .scratch/x.md" })).toBe(false)
    expect(isScratchWrite("Read", { file_path: ".scratch/x.md" })).toBe(false)
    expect(isScratchWrite("Write", "string-input")).toBe(false)
    expect(isScratchWrite("Write", null)).toBe(false)
    expect(isScratchWrite("Write", {})).toBe(false)
  })
})

/** 重试链推进：先排空微任务让 catch 落地并注册 500ms sleep 定时器，
 *  再推进定时器，最后再排空（resolve→setBatches→finally 多轮微任务）。 */
async function flushRetry(ms: number) {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
  vi.advanceTimersByTime(ms)
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

describe("useBatchTree — 触发四路 (AC2)", () => {
  it("① mount 恰一次；taskId 切换重拉", async () => {
    const { rerender } = renderHook(({ id }) => useBatchTree(id), { initialProps: { id: "t1" } })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(1)
    rerender({ id: "t2" })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getBatchTree).mock.calls[1][0]).toBe("t2")
  })

  it("③ R1：toolCalls 出现完成的 .scratch 写 → debounce 后恰重拉一次；burst 合并；同 id 不复燃", async () => {
    const { rerender } = renderHook(
      ({ calls }) => useBatchTree("t1", { toolCalls: calls }),
      { initialProps: { calls: [] as ToolCallRecord[] } },
    )
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(1) // 仅 mount
    vi.mocked(getBatchTree).mockClear()

    // 一轮 burst：两条完成写（spec + 票）+ 一条无关写 + 一条未完成写
    const burst = [
      tc("a", "Write", { file_path: ".scratch/d/x/spec.md" }, "result"),
      tc("b", "Write", { file_path: ".scratch/d/x/issues/01.md" }, "success"),
      tc("c", "Write", { file_path: "artifacts/y.md" }, "result"),
      tc("d", "Edit", { file_path: ".scratch/d/x/issues/02.md" }, "running"),
    ]
    rerender({ calls: burst })
    await flush(R1_DEBOUNCE_MS + 100)
    expect(getBatchTree).toHaveBeenCalledTimes(1) // debounce 合并成一次

    // start→完成边沿补刀：d 转 success 后再来一帧 → 再来一次 debounce 拉取
    rerender({ calls: [...burst, { ...burst[3], status: "success" }] })
    await flush(R1_DEBOUNCE_MS + 100)
    expect(getBatchTree).toHaveBeenCalledTimes(2)

    // 同一批 toolCalls 重渲染（引用变了但 id 都处理过）→ 不再触发
    rerender({ calls: [...burst, { ...burst[3], status: "success" }] })
    await flush(R1_DEBOUNCE_MS + 100)
    expect(getBatchTree).toHaveBeenCalledTimes(2)
  })

  it("② version bump 立即重拉（首帧跳过；同值不重拉）", async () => {
    const { rerender } = renderHook(
      ({ v }) => useBatchTree("t1", { versionKey: v }),
      { initialProps: { v: 1 } },
    )
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(1)
    rerender({ v: 2 })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(2)
    rerender({ v: 2 })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(2)
  })

  it("④ streaming true→false 边沿重拉；常假不拉", async () => {
    const { rerender } = renderHook(
      ({ s }) => useBatchTree("t1", { streaming: s }),
      { initialProps: { s: true } },
    )
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(1) // mount
    rerender({ s: false })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(2) // 边沿
    rerender({ s: false })
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(2)
  })

  it("首败重试一次即成功 → 不显错（连接层抖动自愈，2026-09-09）", async () => {
    vi.mocked(getBatchTree)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce([])
    const { result } = renderHook(() => useBatchTree("t1"))
    await flushRetry(RETRY_DELAY_MS + 100)
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(getBatchTree).toHaveBeenCalledTimes(2) // mount 首击 + 500ms 重试
  })

  it("拉取两连败 → error 置文案、batches 保留旧值、loading 落地", async () => {
    vi.mocked(getBatchTree).mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useBatchTree("t1"))
    await flushRetry(RETRY_DELAY_MS + 100)
    expect(result.current.error).toBe("network down")
    expect(result.current.loading).toBe(false)
    expect(result.current.batches).toEqual([])
    expect(getBatchTree).toHaveBeenCalledTimes(2) // 首击 + 恰一次重试
  })

  it("refresh() 手刷立即拉且吞掉在飞 debounce", async () => {
    const { result, rerender } = renderHook(
      ({ calls }) => useBatchTree("t1", { toolCalls: calls }),
      { initialProps: { calls: [] as ToolCallRecord[] } },
    )
    await flush()
    vi.mocked(getBatchTree).mockClear()
    rerender({ calls: [tc("a", "Write", { file_path: ".scratch/x/spec.md" }, "result")] })
    await flush(R1_DEBOUNCE_MS - 100) // debounce 未到期
    expect(getBatchTree).toHaveBeenCalledTimes(0)
    act(() => result.current.refresh())
    await flush()
    expect(getBatchTree).toHaveBeenCalledTimes(1) // 立即一次
    await flush(R1_DEBOUNCE_MS + 200)
    expect(getBatchTree).toHaveBeenCalledTimes(1) // debounce 已被取消
  })
})

describe("对位/摘要纯函数", () => {
  const b: BatchTreeEntry = {
    dir: ".scratch/20260101/alpha",
    slug: "alpha",
    files: [
      { path: ".scratch/20260101/alpha/spec.md", mtime: "m1", bytes: 1 },
      { path: ".scratch/20260101/alpha/issues/01.md", mtime: "m2", bytes: 1 },
    ],
    latest_mtime: "m2",
  }
  it("findSpecEntry：./ 前缀归一命中；绝对/反斜杠开头（扫描域外）→ null", () => {
    expect(findSpecEntry([b], "./.scratch/20260101/alpha/spec.md")?.path)
      .toBe(".scratch/20260101/alpha/spec.md")
    expect(findSpecEntry([b], "C:/x/.scratch/20260101/alpha/spec.md")).toBeNull()
    expect(findSpecEntry([b], "\\.scratch\\20260101\\alpha\\spec.md")).toBeNull() // 前导反斜杠按绝对对待
    expect(findSpecEntry([b], ".scratch/20260101/alpha/nope.md")).toBeNull()
  })
  it("findBatchFor：前缀命中批次；他批/未落盘 → null", () => {
    expect(findBatchFor([b], "./.scratch/20260101/alpha/spec.md")?.slug).toBe("alpha")
    expect(findBatchFor([b], "./.scratch/20260101/beta/spec.md")).toBeNull()
  })
  it("summarizeSpec：KD 数据行数（首列行号）+ 首个正文行，跳过标题/引用/表格", () => {
    const s = summarizeSpec(
      "# 标题\n\n> 引言\n\n正文第一段。\n\n## Key Decisions\n\n| # | Decision | Conclusion | Reason |\n|---|---|---|---|\n| 1 | A | a | r |\n| 2 | B | b | r |\n",
    )
    expect(s.kdRows).toBe(2)
    expect(s.excerpt).toBe("正文第一段。")
  })
})
