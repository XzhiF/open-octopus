// packages/web-app/components/chat-workbench/__tests__/archive-window.test.tsx
//
// 归档台（2026-11-03 v2 精简方案）：只读明细 —— 没有重试 / 落 wiki / 跳过按钮，
// 操作全部回主 Chat。
// 信息架构：顶部状态条 + 页签 [概览 | 知识落点 | 明细]；报告走弹窗。

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
      pack_path: "raw/archives/task-t1",
      pack_created_at: "2026-10-31T12:00:00.000Z",
      pack_item_cap: 6000,
      compile_state: "committed",
      compile_position: null,
      compile_started_at: "2026-10-31T12:00:10.000Z",
      compile_finished_at: "2026-10-31T12:02:20.000Z",
    },
    amendments: [],
    cleanup: null,
    cleanup_in_flight: false,
    ...overrides,
  }
}

async function openTab(id: "overview" | "knowledge" | "detail") {
  fireEvent.click(await screen.findByTestId(`archive-tab-${id}`))
}

beforeEach(() => {
  mockGetTaskArchive.mockReset()
  mockGetKcFsFile.mockReset()
  mockGetKcFsFile.mockResolvedValue({
    content: '---\norigin: "db:x"\ntitle: "验收台账"\n---\n# 验收台账\n\nphase 1 round 1: accepted',
  })
})

describe("ArchiveWindow — 只读明细（v2 页签）", () => {
  it("默认「概览」一屏给结论；project 行 / 反思 / 素材包在「明细」页签", async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveWindow task={task("archiving")} />)

    expect(await screen.findByTestId("archive-window")).toBeTruthy()
    expect(screen.getByTestId("archive-readonly-note").textContent).toContain("只读明细")
    // 概览：结论行 + 状态条；首屏不堆 project 表 / 素材包
    expect(screen.getByTestId("archive-verdict").textContent).toContain("归档编排中")
    expect(screen.getByTestId("archive-panel-overview")).toBeTruthy()
    expect(screen.queryByTestId("archive-project-row")).toBeNull()
    expect(screen.queryByTestId("archive-pack-items")).toBeNull()
    expect(screen.getByText(/已编译/)).toBeTruthy()

    await openTab("detail")
    expect(screen.getByTestId("archive-panel-detail")).toBeTruthy()

    const rows = screen.getAllByTestId("archive-project-row")
    expect(rows).toHaveLength(2)
    expect(screen.getByText(/protected branch/)).toBeTruthy()
    expect(screen.getByText(/1 处术语冲突等 PR review/)).toBeTruthy()

    expect(screen.getByText("已落 wiki")).toBeTruthy()
    expect(screen.getByText("未决")).toBeTruthy()

    // 已冻结素材件：类 / 名 / 大小 / 剔除态 + 载入 / 仅指针估算
    expect(screen.getByTestId("archive-pack-items")).toBeTruthy()
    expect(screen.getAllByTestId("archive-pack-item")).toHaveLength(4)
    expect(screen.getByText("验收台账")).toBeTruthy()
    expect(screen.getByText("PR diff（stat + 关键 hunk）")).toBeTruthy()
    expect(screen.getByText("14.4 KB")).toBeTruthy()
    expect(screen.getByText("已剔除")).toBeTruthy()
    expect(screen.getByText(/另 1 件已剔除/)).toBeTruthy()
    expect(screen.getByText("仅指针")).toBeTruthy()

    // 只读：没有重试/落 wiki/跳过等动作按钮；件行本身是可打开预览的只读入口
    expect(screen.queryByRole("button", { name: /重试|落 wiki|跳过/ })).toBeNull()
  })

  it("「知识落点」页签展示编译回执：页数 / 更新优先 / 矛盾 finding", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      knowledge: {
        ...payload().knowledge!,
        wiki_result: {
          status: "committed",
          started_at: "2026-10-31T12:00:10.000Z",
          finished_at: "2026-10-31T12:02:20.000Z",
          commit: "5a5a6690abc",
          changed: true,
          deduped: false,
          created: 2,
          updated: 1,
          contradictions: 1,
          finding_ids: ["fnd-9ba5118"],
          touched: [
            { path: "entities/ent-a.md", type: "entity", created: false },
            { path: "topics/top-b.md", type: "topic", created: true },
            { path: "sources/task-t1.md", type: "source", created: true },
          ],
          warnings: ["日期常青自纠一轮"],
        },
        case_results: [
          {
            queue_task_id: "caw-t1-01",
            action: "merged",
            symptom: "登录接口 500：cookie 未清",
            case_path: "cases/2026-10-27-case-acc38e5918.md",
            occurrences_before: 1,
            occurrences_after: 2,
            finished_at: "2026-10-31T12:01:00.000Z",
          },
          {
            queue_task_id: "caw-t1-02",
            action: "created",
            symptom: "回滚后 session 未失效",
            case_path: "cases/2026-10-31-case-def.md",
            occurrences_before: 0,
            occurrences_after: 1,
            finished_at: "2026-10-31T12:01:10.000Z",
          },
          {
            queue_task_id: "caw-t1-03",
            action: "failed",
            symptom: "锁文件丢失",
            case_path: null,
            occurrences_before: null,
            occurrences_after: null,
            finished_at: "2026-10-31T12:01:20.000Z",
            error: { code: "CASE_ARCHIVE_FAILED", message: "wiki lock held" },
          },
        ],
      },
    }))
    render(<ArchiveWindow task={task("done")} />)

    // 概览结论 + 状态条就能看到落点
    expect(await screen.findByText("知识已落库")).toBeTruthy()
    expect(screen.getByText(/3 页：更新 1 · 新建 2 · 1 条矛盾待裁决 · 判例入档 2 · 判例失败 1/)).toBeTruthy()
    expect(screen.getByText("新 2 / 更 1 · 判例 2")).toBeTruthy()
    expect(screen.getByText(/判例入档 · 3/)).toBeTruthy()

    await openTab("knowledge")
    expect(screen.getByTestId("archive-wiki-result")).toBeTruthy()
    expect(screen.getByText("新建页")).toBeTruthy()
    expect(screen.getByText("更新页")).toBeTruthy()
    expect(screen.getAllByTestId("archive-wiki-page")).toHaveLength(3)
    expect(screen.getByText("更新 · 1")).toBeTruthy()
    expect(screen.getByText("新建 · 2")).toBeTruthy()
    expect(screen.getByTestId("archive-wiki-findings").textContent).toContain("fnd-9ba5118")
    expect(screen.getByText(/日期常青自纠一轮/)).toBeTruthy()

    // 判例入档：新建 / 并档 / 失败三种结果同列，并档带 occurrence 前后值
    expect(screen.getByTestId("archive-case-results")).toBeTruthy()
    expect(screen.getAllByTestId("archive-case-result")).toHaveLength(3)
    expect(screen.getByText(/occurrence 1 → 2/)).toBeTruthy()
    expect(screen.getByText("cases/2026-10-27-case-acc38e5918.md")).toBeTruthy()
    expect(screen.getByText(/CASE_ARCHIVE_FAILED: wiki lock held/)).toBeTruthy()
  })

  it("编译中 / 失败：概览有实时盒，知识落点页签给原因", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      knowledge: {
        ...payload().knowledge!,
        compile_state: "running",
        compile_started_at: new Date(Date.now() - 72_000).toISOString(),
        compile_finished_at: null,
      },
    }))
    const { unmount } = render(<ArchiveWindow task={task("done")} />)
    expect(await screen.findByTestId("archive-wiki-running")).toBeTruthy()
    await openTab("knowledge")
    expect(screen.getByText(/为什么知识中心现在还是旧内容/)).toBeTruthy()
    unmount()

    mockGetTaskArchive.mockResolvedValue(payload({
      knowledge: {
        ...payload().knowledge!,
        compile_state: "failed",
        compile_finished_at: "2026-10-31T12:02:20.000Z",
        compile_error: { code: "LINT_FAIL", message: "正文含日期" },
        wiki_result: {
          status: "failed",
          started_at: "2026-10-31T12:00:10.000Z",
          finished_at: "2026-10-31T12:02:20.000Z",
          commit: null,
          changed: false,
          deduped: false,
          created: 0,
          updated: 0,
          contradictions: 0,
          finding_ids: [],
          touched: [],
          warnings: [],
          error: { code: "LINT_FAIL", message: "正文含日期" },
        },
      },
    }))
    render(<ArchiveWindow task={task("done")} />)
    expect(await screen.findByText("知识编译失败")).toBeTruthy()
    await openTab("knowledge")
    expect(screen.getByTestId("archive-wiki-failed").textContent).toContain("LINT_FAIL")
    expect(screen.getByText(/素材包与 raw 文件完好/)).toBeTruthy()
  })

  it("归档报告走弹窗（Esc 关闭），窗口本身不内嵌报告正文", async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveWindow task={task("archiving")} />)

    fireEvent.click(await screen.findByTestId("archive-open-report"))
    const modal = await screen.findByTestId("archive-report-modal")
    expect(within(modal).getByText(/# 归档报告/)).toBeTruthy()
    expect(screen.getByTestId("archive-panel-overview")).toBeTruthy()

    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("archive-report-modal")).toBeNull())
  })

  it("opens a read-only preview dialog for a frozen material item", async () => {
    mockGetTaskArchive.mockResolvedValue(payload())
    render(<ArchiveWindow task={task("archiving")} />)
    await openTab("detail")

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
    await openTab("detail")

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

  it("shows the preflight block (概览), the post-round delta and append-only amendments (明细)", async () => {
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

    await openTab("detail")
    expect(screen.getByTestId("archive-delta")).toBeTruthy()
    expect(screen.getByText("[quick-edit] 收口")).toBeTruthy()
    expect(screen.getByText("未提交 · M src/a.ts")).toBeTruthy()
    expect(screen.getByTestId("archive-amendments")).toBeTruthy()
    expect(screen.getByText("补收尾决策")).toBeTruthy()
    expect(screen.getByText("上线后补灰度开关。")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /重试|落 wiki|跳过/ })).toBeNull()
  })

  it("renders the post-done build-artifact cleanup (freed bytes + leftovers), read-only", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      status: "done",
      cleanup: {
        taskId: "t1",
        startedAt: "2026-10-31T12:00:00.000Z",
        finishedAt: "2026-10-31T12:00:08.000Z",
        status: "done",
        total_freed_bytes: 2500 * 1024,
        projects: [
          {
            project: "api",
            dir: "C:/wt/api",
            ok: true,
            removed_count: 2,
            removed: [{ path: "node_modules", kind: "dir", bytes: 2400 * 1024 }],
            freed_bytes: 2500 * 1024,
            leftover_count: 3,
            leftovers: [{ path: ".idea", kind: "dir", bytes: 1024 }],
          },
        ],
      },
      cleanup_in_flight: false,
    }))
    render(<ArchiveWindow task={task("done")} />)

    // KPI 在概览就可见
    expect(await screen.findByText("构建产物释放")).toBeTruthy()
    await openTab("detail")
    expect(screen.getByTestId("archive-cleanup")).toBeTruthy()
    expect(screen.getByTestId("archive-cleanup-status").textContent).toBe("已清理")
    const rows = screen.getAllByTestId("archive-cleanup-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain("删除 2 项")
    expect(rows[0].textContent).toContain("剩余 ignored 3 项")
    expect(rows[0].textContent).toContain(".idea")
    expect(screen.getAllByText(/释放 2\.4 MB/).length).toBeGreaterThan(0)
    expect(screen.getByText(/清理剩余/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: /清理|删除/ })).toBeNull()
  })

  it("marks a running cleanup as interrupted when the process is no longer in flight", async () => {
    mockGetTaskArchive.mockResolvedValue(payload({
      status: "done",
      cleanup: {
        taskId: "t1",
        startedAt: "2026-10-31T12:00:00.000Z",
        finishedAt: null,
        status: "running",
        total_freed_bytes: 1024,
        projects: [],
      },
      cleanup_in_flight: false,
    }))
    render(<ArchiveWindow task={task("done")} />)
    await openTab("detail")
    expect((await screen.findByTestId("archive-cleanup-status")).textContent).toBe("中断")
    expect(screen.getByTestId("archive-cleanup").textContent).toContain("没有可清理的 project")
  })
})
