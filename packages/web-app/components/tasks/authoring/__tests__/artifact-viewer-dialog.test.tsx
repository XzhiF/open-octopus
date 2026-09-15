// ArtifactViewerDialog — home 模式（验收中列批次证据直读,task-exec-tree 证据面）。
// entry 模式是票 10 既有契约（两个作者态消费方原样）;本套只钉 home 模式三分支
// （200 全文 / 404 collect 后被清 / 413 超上限）+ footer 语境文案。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

/** waitFor 对「回调返回 null」也算成功 —— 显式 throw 才是真轮询。 */
async function findAttr(attr: string): Promise<Element> {
  return waitFor(() => {
    const el = document.querySelector(attr)
    if (!el) throw new Error(`missing ${attr}`)
    return el
  })
}

const { mockGetHomeFile, mockGetArtifactContent } = vi.hoisted(() => ({
  mockGetHomeFile: vi.fn(),
  mockGetArtifactContent: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => {
  class TaskApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "TaskApiError"
      this.status = status
    }
  }
  class ArtifactContentError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "ArtifactContentError"
      this.status = status
    }
  }
  return {
    getHomeFile: mockGetHomeFile,
    getArtifactContent: mockGetArtifactContent,
    ArtifactContentError,
    TaskApiError,
    MAX_HOME_FILE_READ_BYTES: 512_000,
  }
})

import { ArtifactViewerDialog } from "../artifact-viewer-dialog"

const HOME_ENTRY = { path: ".scratch/20260903/scaffold-1/e2e-data/run.txt", bytes: 2048, mtime: "2026-09-03T00:30:00Z" }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ArtifactViewerDialog — homeEntry 模式（批次证据）", () => {
  it("H1: 200 → 全文进 <pre data-artifact-content>；标题=basename；footer 是验收文案", async () => {
    mockGetHomeFile.mockResolvedValue({ path: HOME_ENTRY.path, content: "e2e baseline ok\n" })
    render(
      <ArtifactViewerDialog taskId="t1" entry={null} homeEntry={HOME_ENTRY} onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(mockGetHomeFile).toHaveBeenCalledWith("t1", HOME_ENTRY.path))
    const pre = await findAttr("[data-artifact-content]")
    expect(pre!.textContent).toContain("e2e baseline ok")
    expect(screen.getByText("run.txt")).toBeTruthy()
    expect(screen.getByText(/验收意见请回到右侧动作区/)).toBeTruthy()
  })

  it("H2: 404 → 降级卡说「collect 后被改动/清理」（不是作者态的登记文案）", async () => {
    const { TaskApiError } = await import("@/lib/tasks-api")
    mockGetHomeFile.mockRejectedValue(new TaskApiError("gone", 404))
    render(
      <ArtifactViewerDialog taskId="t1" entry={null} homeEntry={HOME_ENTRY} onOpenChange={() => {}} />,
    )
    const degraded = await findAttr("[data-artifact-degraded]")
    expect(degraded.textContent).toContain("collect")
  })

  it("H3: 413 → 「文件过大」专属降级,并给 512 KB 上限值", async () => {
    const { TaskApiError } = await import("@/lib/tasks-api")
    mockGetHomeFile.mockRejectedValue(new TaskApiError("too large", 413))
    render(
      <ArtifactViewerDialog taskId="t1" entry={null} homeEntry={HOME_ENTRY} onOpenChange={() => {}} />,
    )
    const degraded = await findAttr("[data-artifact-degraded]")
    expect(degraded.textContent).toContain("文件过大")
    expect(degraded.textContent).toContain("512 KB")
  })

  it("H4: entry 模式原契约不动 — getArtifactContent 出口、footer 是作者对话文案", async () => {
    mockGetArtifactContent.mockResolvedValue({ path: "spec.md", content: "# art" })
    const entry = { path: "spec.md", by: "agent", title: "Spec", external: false, updated_at: "2026-09-03T00:00:00Z" }
    render(
      <ArtifactViewerDialog taskId="t1" entry={entry as never} onOpenChange={() => {}} />,
    )
    await waitFor(() => expect(mockGetArtifactContent).toHaveBeenCalledWith("t1", "spec.md"))
    await waitFor(() => expect(document.querySelector("[data-artifact-content]")).toBeTruthy())
    expect(screen.getByText(/在左侧对话里直接说/)).toBeTruthy()
  })
})
