// packages/web-app/components/tasks/files-tab/__tests__/files-tab.test.tsx
//
// 2026-10-28 改版后的「≡ 变更」契约：
//   - GitLab 式左目录树（关键字过滤）/ 右多 tab（懒拉 patch、可关、按口径缓存）
//   - 本轮 / 累计口径：roundIndex === 1 时两口径同区间 → 累计开关禁用并注明
//   - 数据源仍是既有 round-diff(+ /patch)，无新 API（mock 面即契约面）
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
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
import { useEscapeClose } from "@/lib/escape-stack"

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
  roundIndex: 2,
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

function Host(props: {
  serving?: boolean
  isLive?: boolean
  costText?: string | null
  rowDecor?: (f: unknown) => ReactNode
  reveal?: { path: string; nonce: number } | null
  toolbarExtra?: ReactNode
}) {
  const feed = useRoundDiffFeed("t1", props.serving ?? true, 0)
  return (
    <FilesTab
      taskId="t1"
      feed={feed}
      serving={props.serving ?? true}
      isLive={props.isLive ?? true}
      costText={props.costText}
      rowDecor={props.rowDecor as never}
      toolbarExtra={props.toolbarExtra}
      reveal={props.reveal}
    />
  )
}

const row = (key: string) => document.querySelector(`[data-acceptance-diff-row="${key}"]`) as HTMLElement | null

async function waitRow(key: string): Promise<HTMLElement> {
  return waitFor(() => {
    const el = row(key)
    if (!el) throw new Error(`row ${key} not mounted`)
    return el
  })
}

beforeEach(() => {
  mockGetRoundDiff.mockReset()
  mockGetRoundPatch.mockReset()
  mockGetRoundDiff.mockImplementation(((_id: string, scope?: string) =>
    Promise.resolve(scope === "cumulative" ? CUM : ROUND)) as never)
  mockGetRoundPatch.mockResolvedValue({ patch: PATCH, truncated: false })
})

describe("FilesTab — 统计条与目录树", () => {
  it("统计条出提交/文件/+−/干预/成本；过期仓单列警示且不进树", async () => {
    render(<Host costText="$0.42" />)
    const strip = await screen.findByTestId("round-diff-strip")
    expect(strip.textContent).toContain("2")
    expect(strip.textContent).toContain("+10")
    expect(strip.textContent).toContain("−2")
    expect(within(strip).getByText("harness 干预")).toBeTruthy()
    expect(within(strip).getByText("成本")).toBeTruthy()
    expect(screen.getByText("$0.42")).toBeTruthy()
    expect(await screen.findByTestId("round-diff-partial-expired")).toBeTruthy()
    expect(screen.getByTestId("round-diff-repo-octopus")).toBeTruthy()
    // 过期仓只在树里出琥珀行，不出可点文件行
    expect(screen.getByTestId("round-diff-repo-gone").textContent).toContain("⏳")
    expect(row("gone:packages/a.ts")).toBeNull()
  })

  it("树：目录层级 + 文件 A/M 徽标 + ±行；rowDecor 徽标挂到文件行", async () => {
    render(<Host rowDecor={(f) => ((f as { path: string }).path === "packages/quick.ts"
      ? <span data-testid="chat-chip">💬chat</span> : null)} />)
    const a = await waitRow("octopus:packages/a.ts")
    expect(a.textContent).toContain("a.ts")
    expect(a.textContent).toContain("+5")
    expect(a.textContent).toContain("A")
    const b = await waitRow("octopus:packages/b.ts")
    expect(b.textContent).toContain("+3")
    expect(b.textContent).toContain("−2")
    expect(b.textContent).toContain("M")
    expect(screen.getByText("packages/")).toBeTruthy()
    expect(screen.getAllByTestId("chat-chip")).toHaveLength(1)
  })

  it("单链目录压缩成 IntelliJ 风格一行（src/main/java/…）；分叉或有文件处停住", async () => {
    mockGetRoundDiff.mockImplementation((() => Promise.resolve({
      available: true,
      aggregate: { commits: 1, additions: 2, dels: 0, files: 2 },
      interventions: null,
      repos: [{
        name: "app", commits: 1, additions: 2, dels: 0, files: 2, truncated: false,
        groups: [{ dir: "src/main/java/com/octopus", additions: 2, dels: 0, files: [
          { path: "src/main/java/com/octopus/Foo.java", status: "A", adds: 1, dels: 0 },
          { path: "src/main/java/com/octopus/util/Bar.java", status: "A", adds: 1, dels: 0 },
        ] }],
      }],
    })) as never)

    render(<Host />)
    await waitRow("app:src/main/java/com/octopus/Foo.java")
    // 5 层单链压成一行；中间层不再单独出行（长链前缀截断、尾部两段常显）
    const chain = screen.getByTitle("src/main/java/com/octopus")
    expect(chain.textContent).toContain("src/main/java/")
    expect(chain.textContent).toContain("com/octopus/")
    expect(screen.queryByText("src/")).toBeNull()
    expect(screen.queryByText("main/")).toBeNull()
    expect(screen.queryByText("java/")).toBeNull()
    // octopus 层有文件 + 子目录 → 不继续并进去；util 自己是单层目录
    expect(screen.getByText("util/")).toBeTruthy()

    // 点压缩行 → 整条链收起；再点展开
    fireEvent.click(chain)
    await waitFor(() => expect(row("app:src/main/java/com/octopus/Foo.java")).toBeNull())
    fireEvent.click(screen.getByTitle("src/main/java/com/octopus"))
    await waitFor(() => expect(row("app:src/main/java/com/octopus/Foo.java")).toBeTruthy())
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

  it("draft：如实说明，不发请求", () => {
    render(<Host serving={false} />)
    expect(screen.getByTestId("files-tab-idle")).toBeTruthy()
    expect(mockGetRoundDiff).not.toHaveBeenCalled()
  })
})

describe("FilesTab — 左树关键字过滤", () => {
  it("只留命中文件，标题计数同步；清空恢复", async () => {
    render(<Host />)
    await waitRow("octopus:packages/a.ts")
    const input = screen.getByTestId("files-tab-filter")
    fireEvent.change(input, { target: { value: "b.ts" } })

    await waitFor(() => expect(row("octopus:packages/b.ts")).toBeTruthy())
    expect(row("octopus:packages/a.ts")).toBeNull()
    expect(screen.getByTestId("files-tab-tree").textContent).toContain("1/4")

    fireEvent.change(input, { target: { value: "" } })
    await waitFor(() => expect(row("octopus:packages/a.ts")).toBeTruthy())
  })

  it("无命中 → 明确空态，而不是空白树", async () => {
    render(<Host />)
    await waitRow("octopus:packages/a.ts")
    fireEvent.change(screen.getByTestId("files-tab-filter"), { target: { value: "nowhere" } })
    expect(await screen.findByTestId("files-tab-filter-empty")).toHaveTextContent("没有匹配「nowhere」")
    expect(row("octopus:packages/a.ts")).toBeNull()
  })

  it("全部收起 / 全部展开按钮 + 筛选时禁用", async () => {
    render(<Host />)
    await waitRow("octopus:packages/a.ts")
    const toggle = screen.getByTestId("files-tab-toggle-all")
    expect(toggle).not.toBeDisabled()

    fireEvent.click(toggle)
    await waitFor(() => expect(row("octopus:packages/a.ts")).toBeNull())
    // 仓根还在，只是目录层收起
    expect(screen.getByTestId("round-diff-repo-octopus")).toBeTruthy()
    expect(screen.getByTestId("files-tab-toggle-all").getAttribute("aria-label")).toBe("全部展开")

    fireEvent.click(screen.getByTestId("files-tab-toggle-all"))
    await waitFor(() => expect(row("octopus:packages/a.ts")).toBeTruthy())

    fireEvent.change(screen.getByTestId("files-tab-filter"), { target: { value: "a.ts" } })
    expect(screen.getByTestId("files-tab-toggle-all")).toBeDisabled()
  })
})

describe("FilesTab — 左树宽度拖拽", () => {
  it("拖拽分隔条改宽度，并夹在 180–560", async () => {
    render(<Host />)
    await screen.findByTestId("round-diff-strip")
    const tree = screen.getByTestId("files-tab-tree")
    expect(tree.style.width).toBe("270px")

    const handle = screen.getByTestId("files-tab-resizer")
    fireEvent.pointerDown(handle, { clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 380, pointerId: 1 })
    await waitFor(() => expect(tree.style.width).toBe("350px"))

    fireEvent.pointerMove(handle, { clientX: 2000, pointerId: 1 })
    await waitFor(() => expect(tree.style.width).toBe("560px"))
    fireEvent.pointerMove(handle, { clientX: -500, pointerId: 1 })
    await waitFor(() => expect(tree.style.width).toBe("180px"))
    fireEvent.pointerUp(handle, { clientX: -500, pointerId: 1 })

    // 松手后再移动不再改宽度
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 })
    expect(tree.style.width).toBe("180px")
  })
})

describe("FilesTab — tab 右键菜单", () => {
  const tabs = () => screen.getByTestId("files-tab-tabs").querySelectorAll('[role="tab"]')

  async function openThree() {
    fireEvent.click(await waitRow("octopus:packages/a.ts"))
    fireEvent.click(await waitRow("octopus:packages/b.ts"))
    fireEvent.click(await waitRow("octopus:packages/quick.ts"))
    await waitFor(() => expect(tabs()).toHaveLength(3))
  }

  it("关闭左侧 / 关闭右侧 / 关闭其他 / 关闭全部", async () => {
    render(<Host />)
    await openThree()

    // 中 tab 右键 → 关闭左侧（a 走，b/quick 留）
    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/b.ts"), { clientX: 120, clientY: 80 })
    expect(screen.getByTestId("files-tab-tab-menu")).toBeTruthy()
    fireEvent.click(screen.getByTestId("files-tab-tab-menu-left"))
    await waitFor(() => expect(tabs()).toHaveLength(2))
    expect(screen.queryByTestId("files-tab-tab-octopus:packages/a.ts")).toBeNull()
    expect(screen.queryByTestId("files-tab-tab-menu")).toBeNull()

    // 现在 b 是最左 → 关闭右侧：只剩 b
    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/b.ts"), { clientX: 120, clientY: 80 })
    fireEvent.click(screen.getByTestId("files-tab-tab-menu-right"))
    await waitFor(() => expect(tabs()).toHaveLength(1))
    expect(screen.getByTestId("files-tab-tab-octopus:packages/b.ts")).toBeTruthy()

    // 再开一个 → 关闭其他，只留 quick
    fireEvent.click(await waitRow("octopus:packages/quick.ts"))
    await waitFor(() => expect(tabs()).toHaveLength(2))
    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/quick.ts"), { clientX: 120, clientY: 80 })
    fireEvent.click(screen.getByTestId("files-tab-tab-menu-others"))
    await waitFor(() => expect(tabs()).toHaveLength(1))
    expect(screen.getByTestId("files-tab-tab-octopus:packages/quick.ts")).toBeTruthy()

    // 关闭全部 → 空态
    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/quick.ts"), { clientX: 120, clientY: 80 })
    fireEvent.click(screen.getByTestId("files-tab-tab-menu-all"))
    await waitFor(() => expect(tabs()).toHaveLength(0))
    expect(screen.getByTestId("files-tab-pane-empty")).toBeTruthy()
  })

  it("不可用项禁用：单 tab 时「关闭其他/左侧/右侧」灰掉", async () => {
    render(<Host />)
    fireEvent.click(await waitRow("octopus:packages/a.ts"))
    await waitFor(() => expect(tabs()).toHaveLength(1))
    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/a.ts"), { clientX: 100, clientY: 100 })
    expect(screen.getByTestId("files-tab-tab-menu-others")).toBeDisabled()
    expect(screen.getByTestId("files-tab-tab-menu-left")).toBeDisabled()
    expect(screen.getByTestId("files-tab-tab-menu-right")).toBeDisabled()
    expect(screen.getByTestId("files-tab-tab-menu-all")).not.toBeDisabled()
  })

  it("Esc 只关菜单：任务窗的 escape 层级（priority 20）不被触发", async () => {
    const windowClose = vi.fn()
    function WindowEscapeProbe() {
      useEscapeClose(true, windowClose, 20)
      return null
    }
    render(<><Host /><WindowEscapeProbe /></>)
    fireEvent.click(await waitRow("octopus:packages/a.ts"))
    await waitFor(() => expect(tabs()).toHaveLength(1))

    fireEvent.contextMenu(screen.getByTestId("files-tab-tab-octopus:packages/a.ts"), { clientX: 100, clientY: 100 })
    expect(screen.getByTestId("files-tab-tab-menu")).toBeTruthy()

    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByTestId("files-tab-tab-menu")).toBeNull())
    expect(windowClose).not.toHaveBeenCalled()
  })
})

describe("FilesTab — 文件 tab / patch", () => {
  it("点文件 → 开 tab 并懒拉 patch（repo+path）；双行号渲染；切 tab 不重复拉", async () => {
    render(<Host />)
    fireEvent.click(await waitRow("octopus:packages/a.ts"))
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/a.ts"))
    const patch = await screen.findByTestId("round-diff-patch")
    expect(patch.textContent).toContain("-del")
    expect(patch.textContent).toContain("+add1")

    const rows = patch.querySelectorAll("[data-diff-line]")
    const del = [...rows].find((el) => el.getAttribute("data-diff-line") === "del")!
    expect(del.getAttribute("data-diff-old")).toBe("2")
    expect(del.getAttribute("data-diff-new")).toBeNull()
    const add1 = [...rows].find((el) => el.getAttribute("data-diff-line") === "add")!
    expect(add1.getAttribute("data-diff-new")).toBe("2")

    // 再开第二个文件 → 两个 tab
    fireEvent.click(await waitRow("octopus:packages/b.ts"))
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/b.ts"))
    expect(screen.getByTestId("files-tab-tabs").querySelectorAll('[role="tab"]')).toHaveLength(2)

    // 切回 a.ts：缓存命中，不重复拉
    fireEvent.click(screen.getByTestId("files-tab-tab-octopus:packages/a.ts"))
    await waitFor(() => expect(screen.getByTestId("files-tab-file-meta").textContent).toContain("packages/a.ts"))
    expect(mockGetRoundPatch).toHaveBeenCalledTimes(2)

    // 关 tab → 剩一个
    fireEvent.click(screen.getByLabelText("关闭 packages/a.ts"))
    await waitFor(() => expect(screen.getByTestId("files-tab-tabs").querySelectorAll('[role="tab"]')).toHaveLength(1))
  })

  it("超长截断提示在位", async () => {
    mockGetRoundPatch.mockResolvedValue({ patch: PATCH, truncated: true })
    render(<Host />)
    fireEvent.click(await waitRow("octopus:packages/b.ts"))
    expect(await screen.findByText(/超 512K 已截断/)).toBeTruthy()
  })

  it("binary 文件：不拉 patch，出「存在性即证据」说明", async () => {
    render(<Host />)
    fireEvent.click(await waitRow("octopus:packages/logo.png"))
    expect(await screen.findByText(/二进制文件/)).toBeTruthy()
    expect(mockGetRoundPatch).not.toHaveBeenCalled()
  })

  it("patch 失败 → 错误面 + 重试（不吞错）", async () => {
    mockGetRoundPatch.mockRejectedValueOnce(new Error("patch 炸了"))
    render(<Host />)
    fireEvent.click(await waitRow("octopus:packages/a.ts"))
    expect(await screen.findByTestId("files-tab-patch-error")).toHaveTextContent("patch 炸了")
    fireEvent.click(screen.getByText("重试"))
    expect(await screen.findByTestId("round-diff-patch")).toBeTruthy()
  })
})

describe("FilesTab — 本轮/累计口径", () => {
  it("切「累计」→ 拉 cumulative 口径；统计与树同源变化；累计独有文件带 scope 拉 patch", async () => {
    render(<Host />)
    await screen.findByTestId("round-diff-strip")
    expect(mockGetRoundDiff).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId("files-tab-scope-cum"))
    await waitFor(() => expect(mockGetRoundDiff).toHaveBeenCalledWith("t1", "cumulative"))
    await waitFor(() => expect(screen.getByTestId("round-diff-strip").textContent).toContain("+30"))
    expect(screen.getByTestId("round-diff-strip").textContent).toContain("5")
    expect(await waitRow("octopus:packages/z.ts")).toBeTruthy()

    fireEvent.click(row("octopus:packages/z.ts")!)
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/z.ts", "cumulative"))

    fireEvent.click(screen.getByTestId("files-tab-scope-round"))
    await waitFor(() => expect(screen.getByTestId("round-diff-strip").textContent).toContain("+10"))
    // 累计独有的 z.ts 不在本轮 → 树行与 tab 都收起
    await waitFor(() => expect(row("octopus:packages/z.ts")).toBeNull())
    expect(screen.queryByTestId("files-tab-tab-octopus:packages/z.ts")).toBeNull()
  })

  it("roundIndex === 1：累计开关禁用并注明「累计 = 本轮」", async () => {
    mockGetRoundDiff.mockImplementation((() => Promise.resolve({ ...ROUND, roundIndex: 1 })) as never)
    render(<Host />)
    await screen.findByTestId("round-diff-strip")
    const cum = screen.getByTestId("files-tab-scope-cum") as HTMLButtonElement
    expect(cum.disabled).toBe(true)
    expect(screen.getByTestId("files-tab-cum-redundant").textContent).toContain("累计 = 本轮")
    fireEvent.click(cum)
    expect(mockGetRoundDiff).not.toHaveBeenCalledWith("t1", "cumulative")
  })
})

describe("FilesTab — 票07 reveal：对话页签「查看 diff」跳链", () => {
  it("reveal 命中（工作区绝对路径、反斜杠）→ 自动开 tab + 树行青闪", async () => {
    render(<Host reveal={{ path: "C:\\ws\\projects\\octopus\\packages\\b.ts", nonce: 1 }} />)
    await waitFor(() => expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/b.ts"))
    expect(await screen.findByTestId("round-diff-patch")).toBeTruthy()
    const flash = document.querySelector('[data-diff-flash="true"]')
    expect(flash).toBeTruthy()
    expect(flash!.getAttribute("data-acceptance-diff-row")).toBe("octopus:packages/b.ts")
    expect(screen.getByTestId("files-tab-file-meta").textContent).toContain("packages/b.ts")
    expect(document.querySelectorAll('[data-diff-flash="true"]')).toHaveLength(1)
  })

  it("nonce 递增 → 再闪一次；不命中的路径不谎闪", async () => {
    const { rerender } = render(<Host reveal={{ path: "nowhere/zz.ts", nonce: 1 }} />)
    await screen.findByTestId("round-diff-strip")
    expect(document.querySelector('[data-diff-flash="true"]')).toBeNull()
    expect(screen.queryByTestId("round-diff-patch")).toBeNull()

    rerender(<Host reveal={{ path: "C:/ws/projects/octopus/packages/a.ts", nonce: 2 }} />)
    await waitFor(() => expect(document.querySelector('[data-diff-flash="true"]')).toBeTruthy())
    expect(mockGetRoundPatch).toHaveBeenCalledWith("t1", "octopus", "packages/a.ts")
  })

  it("toolbarExtra：07 的 chat ×N chip 原样进工具行", async () => {
    render(<Host toolbarExtra={<button data-testid="chat-ctx-chip">💬 chat 快改 ×2</button>} />)
    await screen.findByTestId("round-diff-strip")
    const toolbar = screen.getByTestId("files-tab-toolbar")
    expect(within(toolbar).getByTestId("chat-ctx-chip").textContent).toContain("×2")
  })
})

describe("FilesTab — 降级面", () => {
  it("409「还没有任何轮」→ idle 面而不是错误面（末态回看的常态）", async () => {
    mockGetRoundDiff.mockRejectedValueOnce(
      Object.assign(new Error("当前没有可出示的轮次"), { status: 409 }),
    )
    render(<Host />)
    expect(await screen.findByTestId("files-tab-idle")).toBeTruthy()
    expect(screen.queryByTestId("files-tab-error")).toBeNull()
  })

  it("首发失败（非 409）→ 错误面 + 重试钮；重试成功出内容", async () => {
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
