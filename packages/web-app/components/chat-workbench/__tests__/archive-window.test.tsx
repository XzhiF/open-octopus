// packages/web-app/components/chat-workbench/__tests__/archive-window.test.tsx
//
// 归档台（2026-10-31 AI-native 归档 v2）：只读明细 —— 没有重试 / 落 wiki / 跳过
// 按钮，操作全部回主 Chat。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import type { TaskArchivePayload, TaskView } from "@/lib/tasks-api"

const { mockGetTaskArchive, mockGetKcFsFile } = vi.hoisted(() => ({
  mockGetTaskArchive: vi.fn(),
  mockGetKcFsFile: vi.fn(),
}))
vi.mock("@/lib/tasks-api", () => ({ getTaskArchive: mockGetTaskArchive }))
vi.mock("@/lib/knowledge/knowledge-center-api", () => ({ getKcFsFile: mockGetKcFsFile }))

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
    knowledge: {
      pack_items: 7,
      items: [
        { kind: "acceptance-ledger", name: "验收台账", bytes: 197, excluded: false, path: "raw/archives/task-t1/01-acceptance-ledger.md" },
        { kind: "pr-diff", name: "PR diff（stat + 关键 hunk）", bytes: 14739, excluded: false, path: "raw/archives/task-t1/04-pr-diff.md" },
        { kind: "archive-summary", name: "归档总结", bytes: 8384, excluded: false, path: "raw/archives/task-t1/07-archive-summary.md" },
        { kind: "matt-artifacts", name: "matt 产物指针", bytes: 2392, excluded: true, path: "raw/archives/task-t1/05-matt-artifacts.md" },
      ],
      compile_state: "committed",
      compile_position: null,
    },
    amendments: [],
    ...overrides,
  }
}

beforeEach(() => {
  mockGetTaskArchive.mockReset()
  mockGetKcFsFile.mockReset()
  mockGetKcFsFile.mockResolvedValue({
    content: '---\norigin: "db:x"\ntitle: "验收台账"\n---\n# 验收台账\n\nphase 1 round 1: accepted',
  })
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

    // 已冻结素材件可展开看「哪几件」：件名 / 类 / 大小 / 剔除态
    expect(screen.getByTestId("archive-pack-items")).toBeTruthy()
    expect(screen.getAllByTestId("archive-pack-item")).toHaveLength(4)
    expect(screen.getByText("验收台账")).toBeTruthy()
    expect(screen.getByText("PR diff（stat + 关键 hunk）")).toBeTruthy()
    expect(screen.getByText("14.4 KB")).toBeTruthy()
    expect(screen.getByText("已剔除")).toBeTruthy()
    expect(screen.getByText(/另 1 件已剔除/)).toBeTruthy()

    // 只读：没有重试/落 wiki/跳过等动作按钮；件行本身是可打开预览的只读入口
    expect(screen.queryByRole("button", { name: /重试|落 wiki|跳过/ })).toBeNull()
    expect(screen.getAllByTestId("archive-pack-item")).toHaveLength(4)
  })

  it("opens a read-only preview dialog for a frozen material item", async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveWindow task={task("archiving")} />)

    const entries = await screen.findAllByTestId("archive-pack-item")
    expect(mockGetKcFsFile).not.toHaveBeenCalled()
    fireEvent.click(entries[0])

    await waitFor(() =>
      expect(mockGetKcFsFile).toHaveBeenCalledWith("raw/archives/task-t1/01-acceptance-ledger.md"),
    )
    const dialog = await screen.findByTestId("archive-pack-dialog")
    expect(within(dialog).getByTestId("archive-pack-markdown")).toBeTruthy()
    expect(within(dialog).getByText(/phase 1 round 1: accepted/)).toBeTruthy()
    // front-matter 五件套不混进正文
    expect(dialog.textContent).not.toContain("origin:")
  })

  it("renders .json material items with token highlighting", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      knowledge: {
        pack_items: 1,
        items: [{ kind: "manifest", name: "manifest.json", bytes: 18, excluded: false, path: "raw/archives/task-t1/manifest.json" }],
        compile_state: null,
        compile_position: null,
      },
    }))
    mockGetKcFsFile.mockResolvedValueOnce({ content: '{"v":1,"items":[]}' })
    render(<ArchiveWindow task={task("archiving")} />)

    fireEvent.click(await screen.findByTestId("archive-pack-item"))
    const json = await screen.findByTestId("archive-pack-json")
    expect(json.querySelector('[data-json-token="key"]')?.textContent).toBe('"v"')
    expect(json.querySelector('[data-json-token="number"]')?.textContent).toBe("1")
  })

  it("awaiting_archive shows a not-started banner instead of pretending to archive", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({ status: "ready", report: null, state: null }))
    render(<ArchiveWindow task={task("awaiting_archive")} />)
    expect(await screen.findByTestId("archive-not-started")).toBeTruthy()
    expect(screen.getByTestId("archive-window").textContent).toContain("待归档 · 未启动")
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
    expect(screen.queryByRole("button", { name: /重试|落 wiki|跳过/ })).toBeNull()
  })
})
