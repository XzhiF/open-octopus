// 工作台「变更」窗口的状态闸回归：末态/draft/ready 没有 awaiting/live 轮，
// round-diff 端点会 409；窗口必须与旧控制台同闸（canServeRoundDiff），
// 落 FilesTab 的 idle 面而不是「实物读取失败」错误面。
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

beforeEach(() => {
  mockGetRoundDiff.mockReset()
})

describe("ChangesWindow — round-diff 状态闸", () => {
  it.each(["done", "failed", "aborted", "draft", "ready", "archiving"])(
    "%s：不拉端点，落 idle 面",
    async (status) => {
      render(<ChangesWindow task={task(status)} />)
      expect(await screen.findByTestId("files-tab-idle")).toBeTruthy()
      expect(mockGetRoundDiff).not.toHaveBeenCalled()
    },
  )

  it("awaiting_review：拉 round 口径并展示实物", async () => {
    mockGetRoundDiff.mockResolvedValue({
      available: true,
      aggregate: { commits: 1, additions: 1, dels: 0, files: 1 },
      interventions: null,
      repos: [
        {
          name: "app", commits: 1, additions: 1, dels: 0, files: 1, truncated: false,
          groups: [
            { dir: ".", additions: 1, dels: 0, files: [{ path: "a.ts", status: "A", adds: 1, dels: 0 }] },
          ],
        },
      ],
    })
    render(<ChangesWindow task={task("awaiting_review")} />)
    expect(await screen.findByTestId("round-diff-strip")).toBeTruthy()
    expect(mockGetRoundDiff).toHaveBeenCalledWith("t1", "round")
  })
})
