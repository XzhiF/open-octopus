// 2026-10-28 task-thread: the persistent status strip above the ONE main chat.
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TaskStatusStrip } from "../task-status-strip"
import type { TaskView } from "@/lib/tasks-api"

function task(status: string, extra: Partial<TaskView> = {}): TaskView {
  return {
    id: "t-1",
    org: "xzf",
    name: "昵称敏感词过滤组件",
    status,
    workspace_id: null,
    execution: null,
    ...extra,
  } as unknown as TaskView
}

describe("TaskStatusStrip", () => {
  it("draft → 任务作者", () => {
    render(<TaskStatusStrip task={task("draft")} />)
    expect(screen.getByTestId("task-strip-identity").textContent).toContain("任务作者")
    expect(screen.getByTestId("task-strip-identity").textContent).not.toContain("执行者")
  })

  it("ready → 执行者待命（入列即切身份）", () => {
    render(<TaskStatusStrip task={task("ready")} />)
    expect(screen.getByTestId("task-strip-identity").textContent).toContain("执行者待命")
  })

  it("running → 执行者 + P/R 坐标", () => {
    render(<TaskStatusStrip task={task("running", {
      execution: { id: "e-1", phase_index: 1, round_index: 2 } as never,
    })} />)
    expect(screen.getByTestId("task-strip-identity").textContent).toContain("执行者")
    expect(screen.getByTestId("task-strip-coord").textContent).toBe("P1 · R2")
  })

  it("archiving → 执行者 · 只读", () => {
    render(<TaskStatusStrip task={task("archiving")} />)
    expect(screen.getByTestId("task-strip-identity").textContent).toContain("只读")
  })

  it("done → 主控 Agent", () => {
    render(<TaskStatusStrip task={task("done")} />)
    expect(screen.getByTestId("task-strip-identity").textContent).toContain("主控 Agent")
  })
})
