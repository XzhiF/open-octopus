// packages/web-app/components/chat-workbench/__tests__/archive-window.test.tsx
//
// 归档台（2026-10-31 AI-native 归档 v2）：只读明细 —— 没有重试 / 落 wiki / 跳过
// 按钮，操作全部回主 Chat。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import type { TaskArchivePayload, TaskView } from "@/lib/tasks-api"

const { mockGetTaskArchive } = vi.hoisted(() => ({ mockGetTaskArchive: vi.fn() }))
vi.mock("@/lib/tasks-api", () => ({ getTaskArchive: mockGetTaskArchive }))

import { ArchiveWindow } from "../archive-window"

const task = (status: string) =>
  ({ id: "t1", name: "归档任务", status }) as unknown as TaskView

function payload(overrides: Partial<TaskArchivePayload> = {}): TaskArchivePayload {
  return {
    task_id: "t1",
    status: "archiving",
    in_flight: false,
    projects: ["api", "web"],
    state: { date: "20261031", projects: { api: { status: "done", commit: "abcdef1234567890" } } },
    report: {
      taskId: "t1",
      date: "20261031",
      ok: false,
      projects: [
        {
          project: "api", ok: true, adrMerged: 2, adrSkipped: [], termsAppended: 1,
          termConflicts: [{ term: "打回单", incoming: "a", existing: "b" }],
          commit: "abcdef1234567890", pushed: true,
          pr: { action: "created", url: "https://x/pr/1" },
        },
        {
          project: "web", ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0,
          termConflicts: [], commit: null, pushed: false, pr: null,
          error: "git push origin feat/x failed: protected branch",
        },
      ],
      unattributedAdrs: [],
      unattributedNotes: 0,
    },
    report_md: "# 归档报告\n- 结果: 存在失败 project",
    reflection: {
      task_id: "t1",
      created_at: new Date().toISOString(),
      entries: [
        { id: "refl-1", title: "长词优先匹配", content: "x", target: "GLOSSARY · 敏感词" },
        { id: "refl-2", title: "修复轮不换流", content: "y" },
      ],
      decisions: { "refl-1": { action: "ingest", at: new Date().toISOString(), raw_path: "raw/inbox/a.md" } },
    },
    knowledge: { pack_items: 7, compile_state: "committed", compile_position: null },
    amendments: [],
    ...overrides,
  }
}

beforeEach(() => {
  mockGetTaskArchive.mockReset()
})

describe("ArchiveWindow — 只读明细", () => {
  it("renders project rows, reflection decisions and the knowledge pack without any action button", async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveWindow task={task("archiving")} />)

    expect(await screen.findByTestId("archive-window")).toBeTruthy()
    expect(screen.getByTestId("archive-readonly-note").textContent).toContain("只读明细")

    const rows = screen.getAllByTestId("archive-project-row")
    expect(rows).toHaveLength(2)
    expect(screen.getByText(/protected branch/)).toBeTruthy()
    expect(screen.getByText(/1 处术语冲突等 PR review/)).toBeTruthy()

    expect(screen.getByText("已落 wiki")).toBeTruthy()
    expect(screen.getByText("未决")).toBeTruthy()
    expect(screen.getByText("已编译")).toBeTruthy()

    // 只读：整窗没有任何按钮（重试/落 wiki/跳过都回主 Chat）
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })

  it("shows the preflight block, the post-round delta and append-only amendments", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      status: "archiving",
      in_flight: false,
      report: {
        taskId: "t1",
        date: "20261031",
        ok: false,
        projects: [
          { project: "api", ok: false, adrMerged: 0, adrSkipped: [], termsAppended: 0, termConflicts: [], commit: null, pushed: false, pr: null, error: "工作区有未提交改动 — 待纳入/排除" },
        ],
        unattributedAdrs: [],
        unattributedNotes: 0,
        preflight: { blocked: true, dirty_projects: ["api"], message: "工作区还有未提交改动（api: 2 个文件）" },
        delta: [
          { project: "api", dir: "C:/wt/api", from: "aaaaaaaa", head: "bbbbbbbb", commits: 2, subjects: ["[quick-edit] 收口"], dirty_files: ["M src/a.ts"] },
        ],
        delta_decision: null,
      },
      amendments: [
        { id: "am-1", at: "2026-10-31T12:00:00.000Z", reason: "补收尾决策", content: "上线后补灰度开关。", target: "ADR · 灰度", ingest: { raw_path: "raw/inbox/a.md" } },
      ],
    }))
    render(<ArchiveWindow task={task("archiving")} />)

    expect(await screen.findByTestId("archive-preflight")).toBeTruthy()
    expect(screen.getByText(/api: 2 个文件/)).toBeTruthy()
    expect(screen.getByTestId("archive-delta")).toBeTruthy()
    expect(screen.getByText("[quick-edit] 收口")).toBeTruthy()
    expect(screen.getByText("未提交 · M src/a.ts")).toBeTruthy()
    expect(screen.getByTestId("archive-amendments")).toBeTruthy()
    expect(screen.getByText("补收尾决策")).toBeTruthy()
    expect(screen.getByText("上线后补灰度开关。")).toBeTruthy()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
