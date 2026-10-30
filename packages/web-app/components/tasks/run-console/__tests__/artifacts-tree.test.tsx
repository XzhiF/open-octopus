// 产物窗口（2026-10-29 方案2）：按 phase × 轮次渲染 —— 每个 phase 一张卡
// （批次级产物 + rN 分组）、未归属产物与工作区原型单列，右侧内联预览。
// 数据由 server 归组（前端不重分类），这里钉渲染与预览读取契约。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ArtifactsTab } from "../artifacts-tab"
import type { ArtifactKind, ArtifactManifestBody, ArtifactManifestItem } from "@/lib/types"

vi.mock("@/lib/tasks-api", () => ({
  readArtifactManifestFile: vi.fn((_taskId: string, path: string) => Promise.resolve({
    path,
    content: path.endsWith(".json") ? '{"up":"npm run dev","ok":true}' : "# 契约与落库\n正文",
  })),
}))

vi.mock("@/components/resource/MarkdownPreview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <pre data-testid="md-preview">{content}</pre>,
  MARKDOWN_TUI_CLASS: "md-tui-stub",
}))

const item = (kind: ArtifactKind, name: string, path: string): ArtifactManifestItem => ({
  name,
  path,
  bytes: 1234,
  mtime: "2026-10-29T14:02:00Z",
  kind,
})

const SPEC = item("spec", "spec.md", "home:.scratch/phone-register/register-flow/spec.md")
const TICKET = item("ticket", "01-prefactor-jwt-common.md", "home:.scratch/phone-register/register-flow/issues/01-prefactor-jwt-common.md")
const RUNBOOK = item("runbook", "runbook.json", "home:.scratch/phone-register/register-flow/runbook/runbook.json")
const FIX = item("fix", "fix-report-r2.md", "home:.scratch/phone-register/register-flow/fix-report-r2.md")
const VERIFY = item("evidence", "verify-r2-1759.md", "home:.scratch/phone-register/register-flow/verify-r2-1759.md")
const LEGACY = item("evidence", "legacy.md", "home:.scratch/legacy/old.md")
const PROTOTYPE = item("prototype", "register-flow.html", "ws:public/prototype/register-flow.html")

const BODY: ArtifactManifestBody = {
  phases: [{
    index: 1,
    name: "契约与落库",
    slug: "register-flow",
    dir: ".scratch/phone-register/register-flow",
    status: "accepted",
    currentRound: 2,
    acceptedRound: 2,
    items: [SPEC, TICKET, RUNBOOK],
    rounds: [{ round: 2, items: [FIX, VERIFY] }],
  }],
  unassigned: [LEGACY],
  prototype: [PROTOTYPE],
}

const EMPTY: ArtifactManifestBody = { phases: [], unassigned: [], prototype: [] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ArtifactsTab — phase × 轮次", () => {
  it("phase 卡：名称 / 验收态 / 件数；批次级产物与 rN 分组分开渲染", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    const phase = screen.getByTestId("artifact-phase-1")
    expect(phase.textContent).toContain("P1")
    expect(phase.textContent).toContain("契约与落库")
    expect(phase.textContent).toContain("已验收")
    expect(phase.textContent).toContain("5 件")

    // 批次级：spec / 票 / runbook
    expect(phase.textContent).toContain("spec.md")
    expect(phase.textContent).toContain("01-prefactor-jwt-common.md")
    expect(phase.textContent).toContain("runbook.json")
    // 轮次分组：fix / verify 在 r2 下
    const round = screen.getByTestId("artifact-round-2")
    expect(round.textContent).toContain("r2")
    expect(round.textContent).toContain("fix-report-r2.md")
    expect(round.textContent).toContain("verify-r2-1759.md")
    expect(screen.getAllByTestId("artifact-row")).toHaveLength(7)
  })

  it("类型徽章由 server 的 kind 单源渲染（spec / 票 / runbook / 修复 / 证据）", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    const phase = screen.getByTestId("artifact-phase-1")
    for (const label of ["spec", "票", "runbook", "修复", "证据"]) {
      expect(phase.textContent).toContain(label)
    }
  })

  it("未归属产物与工作区原型各自单列", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    expect(screen.getByText("未归属产物")).toBeInTheDocument()
    expect(screen.getByText("legacy.md")).toBeInTheDocument()
    expect(screen.getByText("原型（工作区）")).toBeInTheDocument()
    expect(screen.getByText("register-flow.html")).toBeInTheDocument()
  })

  it("点一行 → 右侧现读并渲染 Markdown（不再弹对话框）", async () => {
    const user = userEvent.setup()
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    expect(screen.getByTestId("artifact-preview-empty")).toBeTruthy()
    await user.click(screen.getByText("spec.md"))
    await waitFor(() => expect(screen.getByTestId("md-preview")).toBeTruthy())
    expect(screen.getByTestId("md-preview").textContent).toContain("契约与落库")
    const { readArtifactManifestFile } = await import("@/lib/tasks-api")
    expect(readArtifactManifestFile).toHaveBeenCalledWith("t1", SPEC.path)
  })

  it("JSON 产物（runbook.json）：美化 + token 分色高亮", async () => {
    const user = userEvent.setup()
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    await user.click(screen.getByText("runbook.json"))
    await waitFor(() => expect(screen.getByTestId("json-preview")).toBeTruthy())
    const pre = screen.getByTestId("json-preview")
    expect(pre.querySelector('[data-json-token="key"]')!.textContent).toBe('"up"')
    expect(pre.querySelector('[data-json-token="string"]')!.textContent).toBe('"npm run dev"')
    expect(pre.querySelector('[data-json-token="boolean"]')!.textContent).toBe("true")
    // 美化后带缩进换行（不再是裸的一行）
    expect(pre.textContent).toContain("\n  ")
  })

  it("左右分栏默认 3:7（左 30%），分隔条带 separator 语义可拖", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    expect(screen.getByTestId("artifacts-list-pane").style.width).toBe("30%")
    const handle = screen.getByRole("separator")
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
  })

  it("空清单 → 空态文案", () => {
    render(<ArtifactsTab taskId="t1" body={EMPTY} loading={false} />)
    expect(screen.getByTestId("artifacts-empty")).toBeTruthy()
  })

  it("首次加载（body 未到）→ 加载态", () => {
    render(<ArtifactsTab taskId="t1" body={null} loading />)
    expect(screen.getByTestId("artifacts-loading")).toBeTruthy()
  })
})
