// packages/web-app/components/tasks/files-tab/__tests__/files-tab.test.tsx
//
// 票 03 AC 逐条对号（期望全部取自票文 + 原型 taskboard-v2.html「≡ 变更」结构）：
//   AC1 执行中默认页签可见本轮统计条与文件列表；AC2 点行就地展开/收起 + 懒拉 patch +
//   截断提示；AC3 本轮/累计切换后统计条与列表同源变化；AC5 数据源仍是既有
//   round-diff/patch 端点（无新 API —— mock 面即契约面）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { RoundDiffPayload } from "@/lib/tasks-api"

const { mockGetRoundDiff, mockGetRoundPatch } = vi.hoisted(() => ({
  mockGetRoundDiff: vi.fn(),
  mockGetRoundPatch: vi.fn(),
}))
vi.mock("@/lib/tasks-api", () => ({
  getRoundDiff: mockGetRoundDiff,
  getRoundPatch: mockGetRoundPatch,
  TaskApiError: class extends Error {
    constructor(msg: string, public status = 0) { super(msg) }
  },
}))

import { FilesTab } from "../files-tab"
import { useRoundDiffFeed } from "../use-round-diff-feed"

const ROUND: RoundDiffPayload = {
  available: true,
  aggregate: { commits: 2, additions: 10, dels: 2, files: 4 },
  interventions: 1,
  repos: [
    {
      name: "octopus", commits: 2, additions: 10, dels: 2, files: 4, truncated: false,
      groups: [
        {
          dir: "packages", additions: 8, dels: 2, files: [
            { path: "packages/a.ts", status: "A", adds: 5, dels: 0 },
            { path: "packages/b.ts", status: "M", adds: 3, dels: 2 },
            { path: "packages/quick.ts", status: "M", adds: 0, dels: 0 },
            { path: "packages/logo.png", status: "A", adds: 0, dels: 0, binary: true },
          ],
        },
      ],
    },
    { name: "gone", expired: true, reason: "no_commits", commits: 0, additions: 0, dels: 0, files: 0, truncated: false, groups: [] },
  ],
}

const CUM: RoundDiffPayload = {
  available: true,
  aggregate: { commits: 5, additions: 30, dels: 12, files: 2 },
  interventions: 4,
  repos: [
    {
      name: "octopus", commits: 5, additions: 30, dels: 12, files: 2, truncated: false,
      groups: [
        { dir: "packages", additions: 30, dels: 12, files: [
          { path: "packages/a.ts", status: "A", adds: 20, dels: 0 },
          { path: "packages/z.ts", status: "D", adds: 0, dels: 12 },
        ] },
      ],
    },
  ],
}

const PATCH = "@@ -1,3 +1,4 @@\n ctx1\n-del\n+add1\n+add2\n ctx2\n"

function Host(props: { serving?: boolean; isLive?: boolean; costText?: string | null; rowDecor?: (f: unknown) => ReactNode }) {
  const feed = useRoundDiffFeed("t1", props.serving ?? true, 0)
  return (
    <FilesTab
      taskId="t1"
      feed={feed}
      serving={props.serving ?? true}
      isLive={props.isLive ?? true}
      costText={props.costText}
      rowDecor={props.rowDecor as never}
    />
  )
}

beforeEach(() => {
  mockGetRoundDiff.mockReset()
  mockGetRoundPatch.mockReset()
  mockGetRoundDiff.mockImplementation(((_id: string, scope?: string) =>
    Promise.resolve(scope === "cumulative" ? CUM : ROUND)) as never)
  mockGetRoundPatch.mockResolvedValue({ patch: PATCH, truncated: false })
})

describe("FilesTab — AC1 统计条与文件列表", () => {
  it("执行中：统计条出提交/文件/+−/干预/成本六格；过期仓不入数但单列警示", async () => {
    render(<Host costText="$0.42" />)
    const strip = await screen.findByTestId("round-diff-strip")
    // scopeTotals(octopus)= commits 2 · files 4 · +10 · −2（gone 弃），interventions 1。
    expect(strip.textContent).toContain("2")
    expect(strip.textContent).toContain("+10")
    expect(strip.textContent).toContain("−2")
    expect(screen.getByText("harness 干预")).toBeTruthy()
    expect(screen.getByText("成本")).toBeTruthy()
    expect(screen.getByText("$0.42")).toBeTruthy()
    expect(await screen.findByTestId("round-diff-partial-expired")).toBeTruthy()
    expect(screen.getByTestId("round-diff-repo-octopus")).toBeTruthy()
  })

  it("文件行：A/M/D/R 徽标 + ±行 + 绿红比例条（+8−2 → 80%）", async () => {
    render(<Host />)
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/b.ts"]')
      if (!el) throw new Error("row not mounted")
      return el as HTMLElement
    })
    expect(row.textContent).toContain("+3")
    expect(row.textContent).toContain("−2")
    const bar = row.querySelector("[data-diff-bar]")
    expect(bar?.getAttribute("data-diff-bar")).toBe("60") // 3/(3+2)
  })

  it("执行中零提交：不是空表谎报，而是「首个 commit 落库即出现」提示", async () => {
    mockGetRoundDiff.mockImplementation((() => Promise.resolve({
      available: true,
      aggregate: { commits: 0, additions: 0, dels: 0, files: 0 },
      interventions: null,
      repos: [],
    })) as never)
    render(<Host />)
    expect(await screen.findByTestId("files-tab-empty-live")).toBeTruthy()
  })

  it("不可供货态（如 ready/终态）：如实说明，不发请求", () => {
    render(<Host serving={false} />)
    expect(screen.getByTestId("files-tab-idle")).toBeTruthy()
    expect(mockGetRoundDiff).not.toHaveBeenCalled()
  })
})

describe("FilesTab — AC2 就地展开 unified diff", () => {
  it("点行 → 懒拉 patch（既有端点 repo+path），双行号渲染；再点收起；重开走缓存不再拉", async () => {
    render(<Host />)
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/a.ts"]')
      if (!el) throw new Error("row not mounted")
      return el as HTMLElement
    })
    fireEvent.click(row)
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/a.ts"))
    const patch = await screen.findByTestId("round-diff-patch")
    expect(patch.textContent).toContain("-del")
    expect(patch.textContent).toContain("+add1")
    // 双行号：hunk @@ -1,3 +1,4 @@ 起算 —— del 行旧侧=2；add1 新侧=2；末行 3/4。
    const rows = patch.querySelectorAll("[data-diff-line]")
    const del = [...rows].find((el) => el.getAttribute("data-diff-line") === "del")!
    expect(del.getAttribute("data-diff-old")).toBe("2")
    expect(del.getAttribute("data-diff-new")).toBeNull()
    const add1 = [...rows].find((el) => el.getAttribute("data-diff-line") === "add")!
    expect(add1.getAttribute("data-diff-new")).toBe("2")
    const lastCtx = [...rows].filter((el) => el.getAttribute("data-diff-line") === "ctx").pop()!
    expect(lastCtx.getAttribute("data-diff-old")).toBe("3")
    expect(lastCtx.getAttribute("data-diff-new")).toBe("4")
    fireEvent.click(row) // 收起
    await waitFor(() => expect(screen.queryByTestId("round-diff-patch")).toBeNull())
    fireEvent.click(row) // 重开 → 缓存
    await waitFor(() => expect(screen.getByTestId("round-diff-patch")).toBeTruthy())
    expect(mockGetRoundPatch).toHaveBeenCalledTimes(1)
  })

  it("超长截断提示在位", async () => {
    mockGetRoundPatch.mockResolvedValue({ patch: PATCH, truncated: true })
    render(<Host />)
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/b.ts"]')
      if (!el) throw new Error("row not mounted")
      return el as HTMLElement
    })
    fireEvent.click(row)
    expect(await screen.findByText(/超 512K 已截断/)).toBeTruthy()
  })

  it("binary 行：不拉 patch，出「存在性即证据」说明", async () => {
    render(<Host />)
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/logo.png"]')
      if (!el) throw new Error("row not mounted")
      return el as HTMLElement
    })
    fireEvent.click(row)
    expect(mockGetRoundPatch).not.toHaveBeenCalled()
    expect(await screen.findByText(/二进制文件/)).toBeTruthy()
  })
})

describe("FilesTab — AC3 本轮/累计口径切换", () => {
  it("切「累计」→ 拉 cumulative 口径；统计条与列表同源变成累计载荷", async () => {
    render(<Host />)
    await screen.findByTestId("round-diff-strip")
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("files-tab-scope-cum"))
    await waitFor(() => expect(mockGetRoundDiff).toHaveBeenCalledWith("t1", "cumulative"))
    // 累计 fixture：提交 5 · +30 —— 「本轮」的 +10 不再是当前值。
    await waitFor(() => expect(screen.getByTestId("round-diff-strip").textContent).toContain("+30"))
    expect(screen.getByTestId("round-diff-strip").textContent).toContain("5")
    // 列表同源：累计独有的 z.ts 出现。
    expect(document.querySelector('[data-acceptance-diff-row="octopus:packages/z.ts"]')).toBeTruthy()
    // 切回本轮 → 回到 ROUND 载荷（+10）。
    fireEvent.click(screen.getByTestId("files-tab-scope-round"))
    await waitFor(() => expect(screen.getByTestId("round-diff-strip").textContent).toContain("+10"))
    // 只走既有端点：全程只有 getRoundDiff / getRoundPatch 两个函数被调。
    expect(mockGetRoundDiff.mock.calls.every((c) => c[0] === "t1")).toBe(true)
  })
})

describe("FilesTab — 票间契约与降级面", () => {
  it("rowDecor：票 07 💬chat 徽标钩子按文件渲染在行内", async () => {
    render(<Host rowDecor={(f) => ((f as { path: string }).path === "packages/quick.ts"
      ? <span data-testid="chat-chip">💬chat</span> : null)} />)
    const row = await waitFor(() => {
      const el = document.querySelector('[data-acceptance-diff-row="octopus:packages/quick.ts"]')
      if (!el) throw new Error("row not mounted")
      return el
    })
    expect(row.querySelector("[data-testid=chat-chip]")).toBeTruthy()
    expect(screen.getAllByTestId("chat-chip")).toHaveLength(1)
  })

  it("首发失败 → 错误面 + 重试钮；重试成功出内容（人工出口，不靠下一拍轮询）", async () => {
    mockGetRoundDiff.mockRejectedValueOnce(Object.assign(new Error("diff 读取失败"), { status: 500 }))
    render(<Host />)
    const errBox = await screen.findByTestId("files-tab-error")
    expect(errBox.textContent).toContain("diff 读取失败")
    fireEvent.click(screen.getByTestId("files-tab-retry"))
    expect(await screen.findByTestId("round-diff-strip")).toBeTruthy()
  })

  it("实物不可得（available:false）→ 与走查面同款诚实卡", async () => {
    mockGetRoundDiff.mockImplementation((() => Promise.resolve({
      available: false, reason: "no_commits",
      aggregate: { commits: 0, additions: 0, dels: 0, files: 0 },
      interventions: null,
      repos: [{ name: "octopus", expired: true, reason: "no_commits", commits: 0, additions: 0, dels: 0, files: 0, truncated: false, groups: [] }],
    })) as never)
    render(<Host />)
    expect(await screen.findByTestId("round-diff-expired")).toBeTruthy()
  })
})
