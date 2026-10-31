// 工作台「变更」窗口的状态闸回归（2026-10-31 改判）：
// 服务端轮次解析 = awaiting → live → 停流接管 → 最近已验收轮。所以除 draft 外都
// 值得试一次：末态（done / archiving / awaiting_archive）回看已验收轮的实物区间；
// 真没有轮时端点 409，窗口必须落 FilesTab 的 idle 面而不是「实物读取失败」错误面。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import type { TaskView } from "@/lib/tasks-api"

const { mockGetRoundDiff } = vi.hoisted(() => ({
  mockGetRoundDiff: vi.fn(),
}))
vi.mock("@/lib/tasks-api", () => ({
  getRoundDiff: mockGetRoundDiff,
  getRoundPatch: vi.fn(),
}))

import { ChangesWindow } from "../changes-window"

const task = (status: string) =>
  ({ id: "t1", name: "x", status, task_spec: { format: "v4" } }) as unknown as TaskView

const DIFF = {
  available: true,
  aggregate: { commits: 1, additions: 1, dels: 0, files: 1 },
  interventions: null,
  phaseIndex: 2,
  roundIndex: 1,
  repos: [
    {
      name: "app", commits: 1, additions: 1, dels: 0, files: 1, truncated: false,
      groups: [
        { dir: ".", additions: 1, dels: 0, files: [{ path: "a.ts", status: "A", adds: 1, dels: 0 }] },
      ],
    },
  ],
}

beforeEach(() => {
  mockGetRoundDiff.mockReset()
})

describe("ChangesWindow — round-diff 状态闸", () => {
  it("draft：不拉端点，落 idle 面", async () => {
    render(<ChangesWindow task={task("draft")} />)
    expect(await screen.findByTestId("files-tab-idle")).toBeTruthy()
    expect(mockGetRoundDiff).not.toHaveBeenCalled()
  })

  it.each(["running", "paused", "awaiting_review", "awaiting_archive", "archiving", "done", "failed", "aborted", "ready"])(
    "%s：拉 round 口径（服务端决定有没有已验收轮）",
    async (status) => {
      mockGetRoundDiff.mockResolvedValue(DIFF)
      render(<ChangesWindow task={task(status)} />)
      expect(await screen.findByTestId("round-diff-strip")).toBeTruthy()
      expect(mockGetRoundDiff).toHaveBeenCalledWith("t1", "round")
    },
  )

  it("done + 服务端 409（没有已验收轮）：如实 idle，不报错", async () => {
    mockGetRoundDiff.mockRejectedValue(Object.assign(new Error("当前没有可出示的轮次"), { status: 409 }))
    render(<ChangesWindow task={task("done")} />)
    expect(await screen.findByTestId("files-tab-idle")).toBeTruthy()
    expect(screen.queryByTestId("files-tab-error")).toBeNull()
  })

  it("归档回看：统计条上方标出锚定的 P/R 坐标（冻结快照）", async () => {
    mockGetRoundDiff.mockResolvedValue(DIFF)
    render(<ChangesWindow task={task("done")} />)
    expect((await screen.findByTestId("files-tab-anchor")).textContent).toContain("P2 · R1")
  })
})
