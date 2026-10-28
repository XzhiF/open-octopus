// packages/web-app/components/tasks/files-tab/files-tab.tsx
//
// 票 03 —— 统一壳「≡ 变更」页签本体。
// 2026-10-28 布局改版（作业坞变更窗）：GitLab 式「左目录树 / 右多 tab」——
//   顶部统计条（commits/files/±/干预/成本）· 本轮|累计口径 · 左树关键字过滤 ·
//   右侧文件 tab（懒拉 patch，可同时开多个）。
//   本轮 = 当前轮 start..end；累计 = 本 phase 首轮 start..本轮 end。roundIndex===1
//   时两者同区间 —— 累计开关禁用并注明，不再给用户一个没信息量的按钮。
//
// 数据纪律（票文铁律）：零新后端 —— 只用既有 GET /round-diff(+ /patch)。
// round 口径载荷由壳的 useRoundDiffFeed 单源供入（SSE 事件 + 节流 + ≤10s 兜底，
// 票03 起服务端 live 轮也供货）；cumulative 按需另拉、跟同一节拍补新。
// patch 随口径带 ?scope=cumulative（服务端同一 start 锚）—— 累计列表点开旧轮
// 文件也能出 patch，不再 409。
// 票 07 契约：`rowDecor`（💬chat 徽标渲染位）+ `toolbarExtra`（chat 计数 chip 位），
// reveal（工具卡「查看 diff」跳链）→ 自动开 tab + 树行青闪。

"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode2, Search, X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useEscapeClose } from "@/lib/escape-stack"
import { getRoundDiff, getRoundPatch, type DiffFile, type RoundDiffPayload, type RoundDiffScope } from "@/lib/tasks-api"
import type { RoundDiffFeed } from "./use-round-diff-feed"
import { matchReveal, scopeTotals } from "./files-tab-model"
import { DiffUnavailable, PatchBlock, type FileRowDecor } from "./diff-view"
/** 空态长壳类串（原与 run-console 空态共用；旧控制台退役后在此单源）。 */
const EMPTY_SHELL = "mx-auto mt-10 max-w-[560px] rounded-xl border-[1.5px] border-dashed border-pop-bd bg-pop-idle/40 px-6 py-8 text-center font-mono text-[11px] leading-relaxed text-pop-dim"

export interface FilesTabProps {
  taskId: string
  /** 壳的单源 round 载荷（含节流轮询/事件触发节拍 —— 头栏 commits 也吃它）。 */
  feed: RoundDiffFeed
  /** 当前状态可供货吗（running/paused/awaiting_review；其余如实空置）。 */
  serving: boolean
  /** live 态（显示「≤10s 自动同步」指示 + 零提交预告）。 */
  isLive: boolean
  /** 成本统计位（壳的 llm-calls 聚合，"$0.42" 口径；null/undefined = 不铺该格）。 */
  costText?: string | null
  rowDecor?: FileRowDecor
  toolbarExtra?: ReactNode
  /** 票 07「查看 diff」跳链：工具卡路径（工作区绝对/相对均可）+ nonce —— 每次点击
   *  nonce 递增重触发揭示（自动打开文件 tab + 树行青闪 1.6s）。 */
  reveal?: { path: string; nonce: number } | null
}

/** 树里的一个文件（repo + DiffFile 成对）。 */
interface TreeFile {
  repo: string
  file: DiffFile
  /** 稳定键 `${repo}:${path}`（tab / 缓存 / 揭示都用它）。 */
  key: string
}

interface TreeNode {
  name: string
  /** 仓内相对目录路径（根为 ""）—— 折叠键 = `${repo}:${path}`。 */
  path: string
  dirs: Map<string, TreeNode>
  files: TreeFile[]
}

function buildTree(entries: TreeFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.file.path.split("/").filter(Boolean)
    let node = root
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, path, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(entry)
  }
  return root
}

/** IntelliJ 风格目录压缩：当前层没有文件、且只有一个子目录时，把名字一路接起来，
 *  直到遇到「有文件」或「分叉（>1 子目录）」的那层。
 *  例：src → main → java → com → octopus(Foo.java) ⇒ 一行 `src/main/java/com/octopus/`。 */
function compactDir(node: TreeNode): { label: string; target: TreeNode } {
  let target = node
  let label = node.name
  while (target.files.length === 0 && target.dirs.size === 1) {
    const child = target.dirs.values().next().value as TreeNode
    label = `${label}/${child.name}`
    target = child
  }
  return { label, target }
}

const STATUS_TONE: Record<string, string> = {
  A: "text-pop-green",
  D: "text-pop-red",
  R: "text-pop-cyan",
  C: "text-pop-cyan",
  M: "text-pop-amber",
  T: "text-pop-amber",
}

/** 左树宽度可拖拽区间（px）。 */
export const TREE_MIN_W = 180
export const TREE_MAX_W = 560
export const TREE_DEFAULT_W = 270

export function clampTreeWidth(width: number): number {
  return Math.min(TREE_MAX_W, Math.max(TREE_MIN_W, Math.round(width)))
}

export function FilesTab({ taskId, feed, serving, isLive, costText, rowDecor, toolbarExtra, reveal }: FilesTabProps) {
  const [scope, setScope] = useState<RoundDiffScope>("round")
  const [cum, setCum] = useState<RoundDiffPayload | null>(null)
  const [cumLoading, setCumLoading] = useState(false)
  const [cumError, setCumError] = useState<string | null>(null)
  const [cumReload, setCumReload] = useState(0)

  // ── 左树 / 右 tab 视图状态 ──────────────────────────────────────────
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 左树宽度（拖拽分隔条改；180–560）。 */
  const [treeWidth, setTreeWidth] = useState(TREE_DEFAULT_W)
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  /** tab 右键菜单（fixed 定位在指针处）。 */
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null)

  // patch 缓存按「口径 × repo × path」分键 —— 两个口径的区间不同，不能串。
  const [patches, setPatches] = useState<Record<string, { text: string; truncated: boolean }>>({})
  const [patchErrors, setPatchErrors] = useState<Record<string, string>>({})
  const [patchLoading, setPatchLoading] = useState<Record<string, boolean>>({})
  const requested = useRef<Set<string>>(new Set())

  // 累计口径：按需拉，跟 round 的 nonce 同一节拍补新（票03 刷新动线只开一闸）。
  useEffect(() => {
    if (!serving || scope !== "cumulative") return
    let cancelled = false
    setCumLoading(true)
    setCumError(null)
    getRoundDiff(taskId, "cumulative")
      .then((d) => { if (!cancelled) setCum(d) })
      .catch((e: unknown) => { if (!cancelled) setCumError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setCumLoading(false) })
    return () => { cancelled = true }
  }, [serving, scope, taskId, feed.nonce, cumReload])

  const diff = scope === "round" ? feed.data : cum
  const loading = scope === "round" ? feed.loading : cumLoading
  const error = scope === "round" ? feed.error : cumError
  const stats = scopeTotals(diff)

  // 本 phase 首轮 ⇒ 累计 == 本轮（同区间同数字）—— 开关禁用并注明。
  const cumRedundant = diff?.roundIndex === 1
  useEffect(() => {
    if (cumRedundant && scope === "cumulative") setScope("round")
  }, [cumRedundant, scope])

  // ── 文件全集（过滤/树/统计同源）────────────────────────────────────
  const files = useMemo<TreeFile[]>(() => {
    if (!diff || !diff.available) return []
    const out: TreeFile[] = []
    for (const repo of diff.repos) {
      if (repo.expired) continue
      for (const group of repo.groups) {
        for (const file of group.files) {
          out.push({ repo: repo.name, file, key: `${repo.name}:${file.path}` })
        }
      }
    }
    return out
  }, [diff])

  const visibleFiles = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? files.filter((f) => f.file.path.toLowerCase().includes(q)) : files
  }, [files, filter])

  const fileByKey = useMemo(() => new Map(files.map((f) => [f.key, f])), [files])
  const fileSig = useMemo(() => files.map((f) => f.key).join("|"), [files])

  // 口径刷新后，已打开但不在当前口径里的 tab 自动收起。
  useEffect(() => {
    const alive = new Set(files.map((f) => f.key))
    setOpenTabs((prev) => {
      const next = prev.filter((k) => alive.has(k))
      return next.length === prev.length ? prev : next
    })
    setActiveKey((prev) => (prev && alive.has(prev) ? prev : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSig])

  // 活动 tab 消失（被关闭/口径切换）→ 落到最后一个仍打开的 tab。
  useEffect(() => {
    if (activeKey && openTabs.includes(activeKey)) return
    setActiveKey(openTabs[openTabs.length - 1] ?? null)
  }, [activeKey, openTabs])

  // ── 全部展开 / 全部收起（左树按钮）────────────────────────────────
  // 可折叠键 = 仓根 `${repo}:` + 每层目录 `${repo}:${path}`。
  const treeKeys = useMemo(() => {
    if (!diff) return [] as string[]
    const byRepo = new Map<string, TreeFile[]>()
    for (const entry of files) {
      const list = byRepo.get(entry.repo) ?? []
      list.push(entry)
      byRepo.set(entry.repo, list)
    }
    const keys = new Set<string>()
    for (const repo of diff.repos) {
      if (repo.expired) continue
      const repoFiles = byRepo.get(repo.name)
      if (!repoFiles?.length) continue
      keys.add(`${repo.name}:`)
      for (const entry of repoFiles) {
        const parts = entry.file.path.split("/").filter(Boolean)
        let p = ""
        for (const part of parts.slice(0, -1)) {
          p = p ? `${p}/${part}` : part
          keys.add(`${repo.name}:${p}`)
        }
      }
    }
    return [...keys]
  }, [diff, files])

  const allCollapsed = treeKeys.length > 0 && treeKeys.every((k) => collapsed[k])
  const toggleAllDirs = useCallback(() => {
    setCollapsed(allCollapsed ? {} : Object.fromEntries(treeKeys.map((k) => [k, true])))
  }, [allCollapsed, treeKeys])

  // ── 分隔条拖拽（左树宽度）─────────────────────────────────────────
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startW: treeWidth }
    const el = event.currentTarget
    if (typeof el.setPointerCapture === "function") {
      try { el.setPointerCapture(event.pointerId) } catch { /* jsdom */ }
    }
  }
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setTreeWidth(clampTreeWidth(drag.startW + event.clientX - drag.startX))
  }
  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    const el = event.currentTarget
    if (typeof el.releasePointerCapture === "function") {
      try { el.releasePointerCapture(event.pointerId) } catch { /* jsdom */ }
    }
  }

  // ── tab 右键菜单：关闭其他 / 全部 / 左侧 / 右侧 ────────────────────
  const openTabMenu = (event: ReactMouseEvent<HTMLDivElement>, key: string) => {
    event.preventDefault()
    event.stopPropagation()
    setTabMenu({ key, x: event.clientX, y: event.clientY })
  }

  const applyTabMenu = (action: "others" | "all" | "left" | "right") => {
    if (!tabMenu) return
    const key = tabMenu.key
    const index = openTabs.indexOf(key)
    setTabMenu(null)
    if (action === "all") {
      setOpenTabs([])
      setActiveKey(null)
      return
    }
    if (action === "others") {
      setOpenTabs([key])
      setActiveKey(key)
      return
    }
    if (index < 0) return
    const next = action === "left" ? openTabs.slice(index) : openTabs.slice(0, index + 1)
    setOpenTabs(next)
    setActiveKey((prev) => (prev && next.includes(prev) ? prev : key))
  }

  // 点空白收起右键菜单；Esc 走 escape-stack（比任务窗的关窗层级更高，
  // 只关菜单、不顺手关掉整个变更窗）。
  useEffect(() => {
    if (!tabMenu) return
    const close = () => setTabMenu(null)
    window.addEventListener("pointerdown", close)
    return () => window.removeEventListener("pointerdown", close)
  }, [tabMenu])

  useEscapeClose(tabMenu !== null, () => setTabMenu(null), 100)

  // ── patch 懒拉（按口径缓存；binary 不拉）───────────────────────────
  const patchKeyOf = useCallback(
    (entry: TreeFile) => `${scope}:${entry.key}`,
    [scope],
  )

  const loadPatch = useCallback(
    (entry: TreeFile, force = false) => {
      if (entry.file.binary) return
      const pk = `${scope}:${entry.key}`
      if (!force && requested.current.has(pk)) return
      requested.current.add(pk)
      setPatchErrors((prev) => {
        if (!(pk in prev)) return prev
        const next = { ...prev }
        delete next[pk]
        return next
      })
      setPatchLoading((prev) => ({ ...prev, [pk]: true }))
      const req = scope === "cumulative"
        ? getRoundPatch(taskId, entry.repo, entry.file.path, "cumulative")
        : getRoundPatch(taskId, entry.repo, entry.file.path)
      req
        .then((r) => setPatches((prev) => ({ ...prev, [pk]: { text: r.patch, truncated: r.truncated } })))
        .catch((e: unknown) => {
          requested.current.delete(pk)
          setPatchErrors((prev) => ({ ...prev, [pk]: e instanceof Error ? e.message : String(e) }))
        })
        .finally(() => setPatchLoading((prev) => ({ ...prev, [pk]: false })))
    },
    [scope, taskId],
  )

  const activeEntry = activeKey ? fileByKey.get(activeKey) ?? null : null
  useEffect(() => {
    if (activeEntry) loadPatch(activeEntry)
  }, [activeEntry, loadPatch])

  const openFile = useCallback((entry: TreeFile) => {
    setOpenTabs((prev) => (prev.includes(entry.key) ? prev : [...prev, entry.key]))
    setActiveKey(entry.key)
  }, [])

  const closeTab = useCallback((key: string) => {
    setOpenTabs((prev) => prev.filter((k) => k !== key))
    setActiveKey((prev) => (prev === key ? null : prev))
  }, [])

  // ── 票 07 揭示：命中路径 → 自动开 tab + 树行青闪 ────────────────────
  const seenNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!reveal || !diff) return
    if (seenNonce.current === reveal.nonce) return
    const target = matchReveal(diff, reveal.path)
    if (!target) return
    seenNonce.current = reveal.nonce
    const key = `${target.repo}:${target.path}`
    const entry = fileByKey.get(key)
    if (!entry) return
    openFile(entry)
    setFlashKey(key)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashKey(null), 1600)
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll("[data-acceptance-diff-row]")
      for (const row of rows) {
        if (row.getAttribute("data-acceptance-diff-row") !== key) continue
        ;(row as HTMLElement).scrollIntoView?.({ block: "center" })
        break
      }
    })
  }, [reveal, diff, fileByKey, openFile])

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current)
  }, [])

  // ── 树渲染 ─────────────────────────────────────────────────────────
  /** 压缩后的长链保留尾部两段（叶子目录必须可见），前缀截断。 */
  const renderDirLabel = (label: string) => {
    const parts = label.split("/")
    if (parts.length <= 3) return <span className="truncate">{label}/</span>
    return (
      <span className="flex min-w-0 items-center">
        <span className="truncate">{parts.slice(0, -2).join("/")}/</span>
        <span className="shrink-0">{parts.slice(-2).join("/")}/</span>
      </span>
    )
  }

  const renderDir = (node: TreeNode, repo: string, depth: number): ReactNode => {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))
    const dirRows = dirNames.map((name) => {
      // IntelliJ 风格压缩：单链目录合成一行（com/octopus/demo/…）。
      const { label, target } = compactDir(node.dirs.get(name)!)
      const collapseKey = `${repo}:${target.path}`
      const open = filter.trim() ? true : !collapsed[collapseKey]
      return (
        <div key={collapseKey}>
          <button
            type="button"
            title={label}
            className="flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left font-mono text-[10.5px] font-bold text-pop-dim hover:bg-pop-idle"
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => setCollapsed((prev) => ({ ...prev, [collapseKey]: !prev[collapseKey] }))}
          >
            {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
            <span className="flex min-w-0 flex-1 items-center">{renderDirLabel(label)}</span>
          </button>
          {open && renderDir(target, repo, depth + 1)}
        </div>
      )
    })
    const fileRows = [...node.files]
      .sort((a, b) => a.file.path.localeCompare(b.file.path))
      .map((entry) => {
        const { file, key } = entry
        const active = activeKey === key
        return (
          <button
            key={key}
            type="button"
            data-acceptance-diff-row={key}
            data-diff-flash={flashKey === key ? "true" : undefined}
            data-active={active ? "true" : undefined}
            title={`${key}  ·  +${file.adds} −${file.dels}`}
            onClick={() => openFile(entry)}
            className={`flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left hover:bg-pop-idle ${
              active ? "bg-pop-cyan-soft/40" : ""
            } ${flashKey === key ? "pop-flash-row" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 }}
          >
            <FileCode2 className="size-3 shrink-0 text-pop-dim" />
            <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${file.status === "D" ? "text-pop-dim line-through" : "text-pop-ink"}`}>
              {file.path.split("/").pop()}
            </span>
            {rowDecor?.(file)}
            <span className={`shrink-0 font-mono text-[8.5px] font-black ${STATUS_TONE[file.status] ?? "text-pop-dim"}`}>
              {file.status}
            </span>
            <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] tabular-nums">
              <span className="text-pop-green">+{file.adds}</span>
              <span className="text-pop-red">−{file.dels}</span>
            </span>
          </button>
        )
      })
    return <>{dirRows}{fileRows}</>
  }

  const renderTree = () => {
    if (!diff) return null
    const expiredRepos = diff.repos.filter((r) => r.expired)
    const filterActive = filter.trim().length > 0
    if (!visibleFiles.length && !expiredRepos.length) {
      return filterActive ? (
        <div className="px-3 py-6 text-center font-mono text-[10.5px] text-pop-dim" data-testid="files-tab-filter-empty">
          没有匹配「{filter.trim()}」的文件
        </div>
      ) : isLive && scope === "round" ? (
        <div className="m-1 rounded-[8px] border-[1.5px] border-dashed border-pop-bd px-3 py-3 text-center font-mono text-[10px] text-pop-dim" data-testid="files-tab-empty-live">
          进行中 · 本轮还没有落第一个 commit —— 新提交落库即自动出现（≤10s）
        </div>
      ) : (
        <div className="px-3 py-6 text-center font-mono text-[10.5px] text-pop-dim">该口径下没有变更文件</div>
      )
    }

    const byRepo = new Map<string, TreeFile[]>()
    for (const entry of visibleFiles) {
      const list = byRepo.get(entry.repo) ?? []
      list.push(entry)
      byRepo.set(entry.repo, list)
    }

    return (
      <>
        {filterActive && !visibleFiles.length && (
          <div className="px-3 py-4 text-center font-mono text-[10.5px] text-pop-dim" data-testid="files-tab-filter-empty">
            没有匹配「{filter.trim()}」的文件
          </div>
        )}
        {expiredRepos.map((repo) => (
          <div
            key={`expired:${repo.name}`}
            className="mb-1 rounded-[7px] border border-dashed border-pop-bd px-2 py-1.5 font-mono text-[10px] text-pop-amber"
            data-testid={`round-diff-repo-${repo.name}`}
          >
            ⏳ {repo.name} · {repo.reason ?? "no_commits"}
          </div>
        ))}
        {diff.repos.filter((r) => !r.expired).map((repo) => {
          const repoFiles = byRepo.get(repo.name) ?? []
          const repoKey = `${repo.name}:`
          const repoOpen = filter.trim() ? true : !collapsed[repoKey]
          if (!repoFiles.length) {
            return (
              <div key={repo.name} data-testid={`round-diff-repo-${repo.name}`} className="mb-1">
                <div className="flex items-center gap-1.5 px-1.5 py-1 font-mono text-[10px] text-pop-dim">
                  <ChevronRight className="size-3" />
                  <span className="font-black">{repo.name}</span>
                  <span className="ml-auto">零变更</span>
                </div>
              </div>
            )
          }
          return (
            <div key={repo.name} data-testid={`round-diff-repo-${repo.name}`} className="mb-1">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-[6px] px-1.5 py-1 text-left font-mono text-[10px] hover:bg-pop-idle"
                onClick={() => setCollapsed((prev) => ({ ...prev, [repoKey]: !prev[repoKey] }))}
              >
                {repoOpen ? <ChevronDown className="size-3 shrink-0 text-pop-dim" /> : <ChevronRight className="size-3 shrink-0 text-pop-dim" />}
                <span className="truncate font-black text-pop-ink">{repo.name}</span>
                <span className="ml-auto shrink-0 tabular-nums text-pop-dim">
                  {repo.commits}c <span className="text-pop-green">+{repo.additions}</span>{" "}
                  <span className="text-pop-red">−{repo.dels}</span>
                </span>
              </button>
              {repoOpen && renderDir(buildTree(repoFiles), repo.name, 1)}
            </div>
          )
        })}
      </>
    )
  }

  // ── 右栏内容 ───────────────────────────────────────────────────────
  const renderPane = () => {
    if (!activeEntry) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center font-mono text-[11px] text-pop-dim" data-testid="files-tab-pane-empty">
          <span>从左侧目录树选择文件查看 diff</span>
          <span className="text-[10px] opacity-70">点文件 → 右侧开 tab；支持同时打开多个</span>
        </div>
      )
    }
    const { repo, file } = activeEntry
    const pk = patchKeyOf(activeEntry)
    const patch = patches[pk]
    const patchErr = patchErrors[pk]
    const busy = patchLoading[pk]
    return (
      <>
        <div className="flex flex-wrap items-center gap-2 border-b border-pop-bd/60 px-3 py-1.5 font-mono text-[10px] text-pop-dim" data-testid="files-tab-file-meta">
          <span className="min-w-0 truncate text-pop-ink" title={`${repo}:${file.path}`}>{file.path}</span>
          <span className={`shrink-0 rounded-[4px] border border-pop-bd px-1 py-px text-[8.5px] font-black ${STATUS_TONE[file.status] ?? "text-pop-dim"}`}>
            {file.status}
          </span>
          {file.oldPath && <span className="shrink-0 text-pop-cyan line-through">{file.oldPath}</span>}
          <span className="shrink-0 text-pop-green">+{file.adds}</span>
          <span className="shrink-0 text-pop-red">−{file.dels}</span>
          <span className="ml-auto shrink-0">{repo} · {scope === "cumulative" ? "本 phase 累计" : "本轮区间"}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {file.binary ? (
            <div className="rounded-md border-[1.5px] border-pop-bd bg-muted/30 p-2 font-mono text-[10px] text-muted-foreground">
              二进制文件 — 不出 patch（存在性即证据）。
            </div>
          ) : patchErr ? (
            <div className="p-2 font-mono text-[11px] text-pop-red" data-testid="files-tab-patch-error">
              {patchErr}
              <button className="ml-2 underline underline-offset-2" onClick={() => loadPatch(activeEntry, true)}>重试</button>
            </div>
          ) : busy || !patch ? (
            <div className="flex items-center gap-2 p-2 font-mono text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> 拉取 patch…
            </div>
          ) : (
            <PatchBlock patch={patch} />
          )}
        </div>
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-tab">
      {/* 工具行：口径段 · 同步指示 · 07 徽标位 · 数据源诚实标注 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[1.5px] border-pop-bd bg-pop-paper px-3 py-2 font-mono text-[10px]" data-testid="files-tab-toolbar">
        <span className="flex overflow-hidden rounded-full border-[1.5px] border-pop-bd font-mono text-[9.5px] font-black" data-testid="files-tab-scope">
          {(["round", "cumulative"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              disabled={s === "cumulative" && cumRedundant}
              aria-selected={scope === s}
              title={
                s === "round"
                  ? "本轮增量（当前/待验收轮 start..end）"
                  : cumRedundant
                    ? "本 phase 首轮：累计与本轮是同一区间"
                    : "本 phase 累计（首轮 start .. 本轮 end）"
              }
              className={`px-2.5 py-px transition-colors ${
                scope === s
                  ? "border-pop-navy bg-pop-navy text-pop-ink"
                  : "bg-pop-paper text-pop-dim hover:text-pop-ink"
              } ${s === "cumulative" && cumRedundant ? "cursor-not-allowed opacity-40 line-through" : ""}`}
              data-testid={s === "round" ? "files-tab-scope-round" : "files-tab-scope-cum"}
            >
              {s === "round" ? "本轮" : "累计"}
            </button>
          ))}
        </span>
        {cumRedundant && (
          <span className="rounded-[6px] border border-pop-amber/40 bg-pop-amber-soft px-1.5 py-px text-[9.5px] text-pop-amber" data-testid="files-tab-cum-redundant">
            本 phase 首轮 · 累计 = 本轮
          </span>
        )}
        {serving && isLive && (
          <span className="flex items-center gap-1 text-pop-cyan" title="SSE 事件触发 + 节流轮询；兜底 ≤10s 一拍（spec 故事9）" data-testid="files-tab-sync">
            <i className="block size-[6px] animate-pulse rounded-full bg-pop-cyan" />≤10s 自动同步
          </span>
        )}
        {toolbarExtra}
        <span className="ml-auto text-pop-dim">数据源 GET /api/tasks/:id/round-diff —— 与走查面同源</span>
      </div>

      {/* 统计条：与列表同源（scopeTotals）—— 数字随口径切换 */}
      {serving && diff && diff.available && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-pop-bd/60 bg-pop-paper/60 px-3 py-1.5 font-mono text-[10px] text-pop-dim" data-testid="round-diff-strip">
          <span><b className="font-black text-pop-ink">{stats.commits}</b> 提交</span>
          <span><b className="font-black text-pop-cyan">{stats.files}</b> 文件</span>
          <span className="text-pop-green">+{stats.additions}</span>
          <span className="text-pop-red">−{stats.dels}</span>
          <span>harness 干预</span>
          <b className={stats.interventions ? "text-pop-amber" : "text-pop-dim"}>{stats.interventions ?? "—"}</b>
          {costText != null && (<><span>成本</span><b className="text-pop-yellow">{costText}</b></>)}
          {diff.repos.some((r) => r.expired) && (
            <span className="text-pop-amber" data-testid="round-diff-partial-expired">
              ⏳ {diff.repos.filter((r) => r.expired).length} 仓实物已过期（不计入统计）
            </span>
          )}
          {diff.repos.some((r) => r.truncated) && <span>文件数超展示上限 — 汇总为截断前值</span>}
        </div>
      )}

      {error && diff && (
        <div className="shrink-0 border-b border-pop-bd bg-pop-amber-soft px-3 py-1.5 font-mono text-[10px] font-black text-pop-amber" data-testid="files-tab-stale">
          ⚠ 刷新失败：{error} —— 下方沿上一帧快照
        </div>
      )}

      <div className="min-h-0 flex-1">
        {!serving ? (
          <div className="p-3">
            <div className={EMPTY_SHELL} data-testid="files-tab-idle">
              实物 diff 只在<b className="text-pop-ink">执行中与待验收</b>供货 —— 当前没有可出示的轮次。<br />
              轮次开跑（或产出入待验收）后本页自动出数；归档终态后回看走「✓ 走查 / 台账」。
            </div>
          </div>
        ) : loading && !diff ? (
          <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground" data-testid="files-tab-loading">
            <Spinner className="size-3.5" /> 读取实物提交区间…
          </div>
        ) : error && !diff ? (
          <div className="p-4 text-[11px]" data-testid="files-tab-error">
            <div className="text-pop-red">实物读取失败：{error}</div>
            <button
              className="mt-1 underline underline-offset-2"
              onClick={() => (scope === "round" ? feed.retry() : setCumReload((v) => v + 1))}
              data-testid="files-tab-retry"
            >
              重试
            </button>
          </div>
        ) : diff && !diff.available ? (
          <DiffUnavailable diff={diff} />
        ) : diff ? (
          <div className="flex h-full min-h-0">
            {/* 左：目录树 + 关键字过滤（宽度可拖拽） */}
            <aside
              className="flex shrink-0 flex-col bg-pop-paper/40"
              style={{ width: treeWidth }}
              data-testid="files-tab-tree"
            >
              <div className="border-b border-pop-bd/60 px-2.5 py-2">
                <div className="flex items-center gap-1.5 font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">
                  FILES CHANGED
                  <span className="ml-auto font-normal tabular-nums">{visibleFiles.length}/{files.length}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[7px] border border-pop-bd bg-pop-paper px-1.5">
                    <Search className="size-3 shrink-0 text-pop-dim" />
                    <input
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="筛选文件…"
                      aria-label="按路径筛选文件"
                      data-testid="files-tab-filter"
                      className="h-6 w-full min-w-0 bg-transparent font-mono text-[10.5px] text-pop-ink outline-none placeholder:text-pop-dim/60"
                    />
                    {filter && (
                      <button type="button" aria-label="清空筛选" onClick={() => setFilter("")} className="shrink-0 text-pop-dim hover:text-pop-ink">
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={allCollapsed ? "全部展开" : "全部收起"}
                    title={filter.trim() ? "筛选时目录自动展开" : allCollapsed ? "全部展开" : "全部收起"}
                    disabled={filter.trim().length > 0 || treeKeys.length === 0}
                    onClick={toggleAllDirs}
                    data-testid="files-tab-toggle-all"
                    className="grid size-6 shrink-0 place-items-center rounded-[6px] border border-pop-bd text-pop-dim transition-colors hover:bg-pop-idle hover:text-pop-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {allCollapsed ? <ChevronsUpDown className="size-3" /> : <ChevronsDownUp className="size-3" />}
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="files-tab-tree-list">
                {renderTree()}
              </div>
            </aside>

            {/* 左右拖拽分隔条 */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录树宽度"
              data-testid="files-tab-resizer"
              onPointerDown={beginResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              className="group relative w-[5px] shrink-0 cursor-col-resize touch-none bg-transparent"
            >
              <span className="absolute inset-y-0 left-[1.5px] w-[1.5px] bg-pop-bd transition-colors group-hover:bg-pop-cyan/70" />
            </div>

            {/* 右：多 tab + diff */}
            <section className="flex min-w-0 flex-1 flex-col bg-pop-bg">
              <div className="flex min-h-[30px] shrink-0 items-end gap-px overflow-x-auto border-b-[1.5px] border-pop-bd bg-pop-paper px-1.5 pt-1" data-testid="files-tab-tabs">
                {openTabs.length === 0 ? (
                  <span className="px-1.5 py-1 font-mono text-[10px] text-pop-dim">未打开文件 · 从左侧选择</span>
                ) : (
                  openTabs.map((key) => {
                    const entry = fileByKey.get(key)
                    if (!entry) return null
                    const active = activeKey === key
                    return (
                      <div
                        key={key}
                        role="tab"
                        aria-selected={active}
                        data-testid={`files-tab-tab-${key}`}
                        onClick={() => setActiveKey(key)}
                        onContextMenu={(event) => openTabMenu(event, key)}
                        className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-[7px] border-[1.5px] border-b-0 px-2 py-1 font-mono text-[10.5px] ${
                          active
                            ? "border-pop-bd bg-pop-bg text-pop-ink"
                            : "border-transparent text-pop-dim hover:bg-pop-idle hover:text-pop-ink"
                        }`}
                        title={`${key}  ·  +${entry.file.adds} −${entry.file.dels}`}
                      >
                        <span className={`text-[8.5px] font-black ${STATUS_TONE[entry.file.status] ?? "text-pop-dim"}`}>{entry.file.status}</span>
                        <span className="max-w-[180px] truncate">{entry.file.path.split("/").pop()}</span>
                        <button
                          type="button"
                          aria-label={`关闭 ${entry.file.path}`}
                          onClick={(event) => { event.stopPropagation(); closeTab(key) }}
                          className="rounded-[3px] px-0.5 text-pop-dim hover:bg-white/[0.09] hover:text-pop-ink"
                        >
                          ×
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <div className="flex min-h-0 flex-1 flex-col" data-testid="files-tab-pane">
                {renderPane()}
              </div>
            </section>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
            <Spinner className="size-3.5" /> 读取中…
          </div>
        )}
      </div>
      {/* tab 右键菜单 */}
      {tabMenu && (() => {
        const index = openTabs.indexOf(tabMenu.key)
        const enabled = {
          others: openTabs.length > 1,
          all: openTabs.length > 0,
          left: index > 0,
          right: index >= 0 && index < openTabs.length - 1,
        }
        const left = Math.max(8, Math.min(tabMenu.x, window.innerWidth - 172))
        const top = Math.max(8, Math.min(tabMenu.y, window.innerHeight - 172))
        return (
          <div
            role="menu"
            data-testid="files-tab-tab-menu"
            style={{ left, top }}
            onPointerDown={(event) => event.stopPropagation()}
            className="fixed z-[80] w-[160px] rounded-[9px] border-[1.5px] border-pop-bd bg-pop-paper p-1 font-mono text-[10.5px] shadow-pop"
          >
            {([
              ["others", "关闭其他"],
              ["all", "关闭全部"],
              ["left", "关闭左侧"],
              ["right", "关闭右侧"],
            ] as const).map(([action, label]) => (
              <button
                key={action}
                type="button"
                role="menuitem"
                disabled={!enabled[action]}
                data-testid={`files-tab-tab-menu-${action}`}
                onClick={() => applyTabMenu(action)}
                className="flex w-full items-center rounded-[6px] px-2 py-1.5 text-left text-pop-ink transition-colors hover:bg-pop-idle disabled:cursor-not-allowed disabled:opacity-35"
              >
                {label}
              </button>
            ))}
          </div>
        )
      })()}
    </div>
  )
}
