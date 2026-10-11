// ready-spec-tab.test.tsx — 票 09 容器位（run-console「▤ 规格」只读镜像）
//
// 钉三件事（组件级「写控件不渲染」契约在 spec-panel.test.tsx 的 readOnly 组，
// 装配级 testid 迁移在 task-run-console.test.tsx 票07 三签组 —— 三层各测各的缝）：
//   1. 镜像上屏：真 SpecPanel（data-spec-panel）+ 原型 f-toolbar 只读口径，
//      六行入队清单全 ✓（gate 已过态 + 同源 computeSpecRows 现算）；
//   2. 取数走任务详情既有 payload：detail.task_spec 优先于看板 task prop；
//   3. 磁盘读通路 = authoring 同款 hooks（batch-tree 落盘命中 → spec 行 ✓；
//      home-tree 出批次目录树）。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import type { TaskDetail } from "@/lib/tasks-api"
import { ReadySpecTab } from "../ready-spec-tab"

if (!globalThis.EventSource) {
  globalThis.EventSource = class {
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return false }
    onmessage = null
    onerror = null
    onopen = null
    readyState = 0
    withCredentials = false
    url = ""
  } as unknown as typeof EventSource
}
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
}

vi.mock("@/lib/tasks-api", () => {
  class TaskApiError extends Error {
    status: number
    constructor(message: string, status: number) { super(message); this.name = "TaskApiError"; this.status = status }
  }
  return {
    getBatchTree: vi.fn(),
    getHomeTree: vi.fn(),
    getHomeContent: vi.fn().mockResolvedValue({ path: "", content: "" }),
    getHomeFile: vi.fn(), putHomeFile: vi.fn(), listHomeDir: vi.fn(),
    getTask: vi.fn(), updateTask: vi.fn(), updateSpecField: vi.fn(),
    getTaskContext: vi.fn(), listArtifacts: vi.fn(), getArtifactContent: vi.fn(),
    TaskApiError,
    ArtifactContentError: class extends Error {},
    MAX_HOME_FILE_READ_BYTES: 1024 * 1024,
  }
})
vi.mock("@/lib/workflow-presets-api", () => ({
  listBuiltInWorkflows: vi.fn().mockResolvedValue([]),
  listWorkflowPresets: vi.fn().mockResolvedValue({ presets: [] }),
  getBuiltInWorkflowDetail: vi.fn(),
}))
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: () => () => {},
  subscribeSSEStatus: () => () => {},
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { getBatchTree, getHomeTree } from "@/lib/tasks-api"

const PHASES: TaskPhase[] = [
  { index: 1, name: "契约与落库", slug: "p1", specPath: "./.scratch/plan-x/p1/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {} },
  { index: 2, name: "实现与收口", slug: "p2", specPath: "./.scratch/plan-x/p2/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {} },
] as unknown as TaskPhase[]

const READY_SPEC = {
  format: "v4", goal: "g", ac: ["a"], phases: PHASES, autoAdvance: true,
  resources: [], authoring_resources: [], skill_groups: [], decisions: [], ac_confirmed: [],
  acceptance_runbook: { up: { command: "pnpm dev" }, ready: { command: "curl -sf localhost:3001/health" } },
} as unknown as TaskSpec

function readyTask(spec: TaskSpec): Task {
  return {
    id: "t-9", org: "default", name: "待执行镜像", status: "ready", task_spec: spec,
    authoring_resources: [], resources: [], skills: [], project_ids: ["octopus"], version: 3,
    deleted_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  } as unknown as Task
}

const BATCHED = [
  { dir: ".scratch/plan-x/p1", slug: "p1", latest_mtime: "2026-10-01T00:00:00Z", files: [{ path: ".scratch/plan-x/p1/spec.md", mtime: "2026-10-01T00:00:00Z", bytes: 10 }] },
  { dir: ".scratch/plan-x/p2", slug: "p2", latest_mtime: "2026-10-01T00:00:00Z", files: [{ path: ".scratch/plan-x/p2/spec.md", mtime: "2026-10-01T00:00:00Z", bytes: 10 }] },
]

beforeEach(() => {
  vi.mocked(getBatchTree).mockReset().mockResolvedValue(BATCHED as never)
  vi.mocked(getHomeTree).mockReset().mockResolvedValue({
    dir: "C:/home/.octopus/tasks/t-9",
    entries: [
      { path: "artifacts/", type: "dir", bytes: 0, mtime: "2026-10-01T00:00:00Z" },
      { path: "artifacts/report.md", type: "file", bytes: 20, mtime: "2026-10-01T00:00:00Z" },
    ],
  } as never)
})

describe("ReadySpecTab — 待执行规格只读镜像（票09）", () => {
  it("镜像上屏：真 SpecPanel + 只读徽标；六行入队清单全 ✓；写控件（＋添加/编辑入口/绑定/开关）计数 0", async () => {
    const task = readyTask(READY_SPEC)
    render(<ReadySpecTab task={task} detail={{ ...task, executions: [], derived: null } as unknown as TaskDetail} />)
    expect(await screen.findByTestId("ready-spec-tab")).toBeTruthy()
    expect(document.querySelector("[data-spec-panel]")).toBeTruthy()
    expect(document.querySelector("[data-ready-spec-readonly-badge]")?.textContent).toContain("只读")
    expect(document.querySelector("[data-ready-spec-toolbar]")?.textContent).toContain("要改请走右栏「↩ 回草稿」")
    // gate 已过 + 批次树全落盘（getBatchTree 桩命中两份 spec）→ 六行全 ✓
    await waitFor(() => {
      for (const id of ["phases", "spec", "bind", "inputs", "runbook", "repos"]) {
        expect(document.querySelector(`[data-checklist-v4="${id}"]`)?.textContent).toContain("✓")
      }
    })
    expect(document.querySelectorAll('[data-checklist-v4="spec"]')[0]?.textContent).toContain("2/2 落盘")
    // 批次目录树照常出（home-tree 桩）
    expect(document.querySelector("[data-artifacts-tree]")).toBeTruthy()
    expect(document.querySelector("[data-artifacts-file='artifacts/report.md']")).toBeTruthy()
    // 写控件全数不渲染（单源换装：由 readOnly 把关，不是靠 status 顺带）
    expect(document.querySelector("[data-phase-add-open]")).toBeNull()
    expect(document.querySelectorAll("[data-phase-spec-button]")).toHaveLength(0)
    expect(document.querySelectorAll("[data-phase-bind-button]")).toHaveLength(0)
    expect(document.querySelector("[data-autoadvance-row]")).toBeNull()
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
  })

  it("取数走任务详情既有 payload：detail.task_spec 优先于看板的旧 task prop", async () => {
    const staleTask = readyTask({ ...READY_SPEC, phases: [] } as unknown as TaskSpec)
    const freshDetail = { ...readyTask(READY_SPEC), executions: [], derived: null } as unknown as TaskDetail
    render(<ReadySpecTab task={staleTask} detail={freshDetail} />)
    // prop 说 0 phases、detail 说 2 → 以 detail 为准（原型 ⓬：phases=2 两瓦片）
    expect(await screen.findByTestId("ready-spec-tab")).toBeTruthy()
    expect(document.querySelector("[data-ready-spec-toolbar]")?.textContent).toContain("phases=2")
    expect(document.querySelector('[data-phase-bind-card="1"]')).toBeTruthy()
    expect(document.querySelector('[data-phase-bind-card="2"]')).toBeTruthy()
    expect(document.querySelector('[data-phase-bind-card="1"]')?.textContent).toContain("契约与落库")
  })
})
