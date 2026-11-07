"use client"

// 工作流 YAML 窗（2026-11-07）—— 两个入口：
//   A. 作业坞「运行」列表行尾的 </> 按钮
//   B. 运行窗头部的「</> YAML」按钮
//
// 展示的是这一次执行实际使用的 YAML：主工作流取执行快照（execution detail 的
// workflow_content + workflow_content_source）。含 dynamic_sub_workflow 的流
// （如 matt-spec-dev 的 ticket-dag）会把运行时生成的子流列进左侧工作流树；子流
// 只有执行作用域快照，没有工作区定义，所以「当前定义」对它禁用。子流尚未生成时
// 树上保留一条禁用的「生成中…」，随执行步骤 / SSE runtime_node_added 自动补上。

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Download, Search } from "lucide-react"
import { toast } from "sonner"
import {
  fetchExecutionDetail,
  fetchWorkflowContent,
  type ExecutionDetailWire,
  type WorkflowContentSource,
} from "@/lib/api-client"
import { getServerUrl } from "@/lib/server-config"
import { subscribeSSE } from "@/lib/sse-manager"
import type { StepExecution } from "@/lib/types"
import { useEscapeClose } from "@/lib/escape-stack"
import {
  clampRect,
  resizeRect,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Rect,
  type ResizeDirection,
  type Size,
} from "@/lib/window-geometry"
import { WindowTitlebar } from "@/components/shell/window-titlebar"
import { WindowResizeHandles } from "@/components/shell/window-resize-handles"
import { cn } from "@/lib/utils"
import {
  collectSubWorkflowRefs,
  workflowDisplayName,
  type SubWorkflowRef,
} from "@/lib/workflow-tree"
import {
  applyMatchHighlights,
  blockScalarFlags,
  countYamlLines,
  diffLineNumbers,
  extractYamlNodes,
  findYamlMatches,
  highlightYamlLine,
  NODE_TYPE_COLORS,
  splitYamlLines,
  type YamlMatch,
  type YamlTokenKind,
} from "@/lib/yaml-display"
import type { YamlTarget } from "./task-window-types"

const ROOT_KEY = "__root__"
const WINDOW_MARGIN = 18
const LIVE_STATUS = new Set([
  "pending",
  "running",
  "paused",
  "pending_approval",
  "pending_interaction",
  "pending_resume",
])

type LoadStatus = "loading" | "ready" | "missing" | "error"

interface LoadState {
  status: LoadStatus
  content?: string
}

interface TreeRow {
  key: string
  name: string
  dynamic: boolean
  child: boolean
  status: LoadStatus
  kind: string
  pending: boolean
  lines: number | null
  title: string
  ready: boolean
}

const TOKEN_CLASS: Record<YamlTokenKind, string> = {
  plain: "text-[#B9BBC6]",
  punct: "text-[#6E7079]",
  key: "text-[#7FD9E0]",
  str: "text-[#9BE8A3]",
  num: "text-pop-amber",
  bool: "text-pop-amber",
  comment: "text-[#5A5C66]",
  mark: "text-pop-purple",
}

function viewportSize(): Size {
  if (typeof window === "undefined") return { width: 1024, height: 768 }
  return { width: window.innerWidth, height: window.innerHeight }
}

/** 工作台（任务模块层）的可视区域 —— 系统窗口的最大化/初始定位都以它为界。 */
function workbenchBounds(): Rect {
  if (typeof window === "undefined") return { x: 40, y: 40, w: 880, h: 600 }
  const layer = document.querySelector('[data-testid="task-modules-layer"]')
  const rect = layer?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
  }
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

/** 最大化跟系统窗口一致：向左出血盖住聊天侧栏，顶边贴住工作台顶部。 */
function maximizedRect(): Rect {
  if (typeof window === "undefined") return { x: 0, y: 0, w: 1024, h: 768 }
  const area = workbenchBounds()
  return { x: 0, y: area.y, w: window.innerWidth, h: area.h }
}

function initialRect(from: YamlTarget["from"]): Rect {
  if (typeof window === "undefined") {
    return { x: 40, y: 40, w: 880, h: 600 }
  }
  const area = workbenchBounds()
  const width = Math.max(MIN_WINDOW_WIDTH, Math.min(from === "run" ? 880 : 1000, area.w - 60))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(from === "run" ? 600 : 660, area.h - 60))
  if (from === "run") {
    return {
      x: area.x + area.w - width - WINDOW_MARGIN,
      y: area.y + area.h - height - WINDOW_MARGIN,
      w: width,
      h: height,
    }
  }
  return {
    x: area.x + Math.round((area.w - width) / 2),
    y: area.y + Math.round(Math.max(18, (area.h - height) * 0.34)),
    w: width,
    h: height,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortExec(executionId: string): string {
  return executionId.slice(0, 8)
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_") || "workflow"
}

export function WorkflowYamlWindow({
  target,
  onClose,
}: {
  target: YamlTarget
  onClose: () => void
}) {
  const { workspaceId, executionId } = target

  const [detail, setDetail] = useState<ExecutionDetailWire | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [children, setChildren] = useState<Record<string, LoadState>>({})
  const [rootCurrent, setRootCurrent] = useState<LoadState | null>(null)
  const [activeRef, setActiveRef] = useState<string | null>(null)
  const [source, setSource] = useState<"snapshot" | "current">("snapshot")
  const [query, setQuery] = useState("")
  const [currentMatch, setCurrentMatch] = useState(0)
  const [stepped, setStepped] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [runtimeVersion, setRuntimeVersion] = useState(0)
  const [flashLine, setFlashLine] = useState<number | null>(null)
  // 窗口壳跟系统任务窗同款：红黄绿三灯 + 拖拽/缩放/最大化。
  const [rect, setRect] = useState<Rect>(() => initialRect(target.from))
  const [maximized, setMaximized] = useState(false)
  const [restoreRect, setRestoreRect] = useState<Rect | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [focused, setFocused] = useState(true)

  const positionerRef = useRef<HTMLDivElement>(null)
  const dragLayerRef = useRef<HTMLDivElement>(null)
  const resizeStartRef = useRef<{ rect: Rect; direction: ResizeDirection } | null>(null)
  const resizeLastRef = useRef<Rect | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const childrenRef = useRef(children)
  const inFlightRef = useRef(new Set<string>())
  const currentAttemptedRef = useRef<string | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  useEscapeClose(focused && !minimized, onClose, 20)

  useEffect(() => {
    childrenRef.current = children
  }, [children])

  // 点窗外 → 失焦（灯变灰、Esc 让给别的窗口）；点窗内 → 重新聚焦。
  useEffect(() => {
    if (minimized) return
    const onPointerDown = (event: PointerEvent) => {
      if (!positionerRef.current?.contains(event.target as Node)) setFocused(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [minimized])

  const rootYaml = detail?.workflow_content ?? ""
  const rootRef = detail?.workflow_ref ?? target.workflowRef ?? null
  const steps = detail?.steps ?? null
  const rootSnapshotSource: WorkflowContentSource | null =
    detail?.workflow_content_source ?? (detail ? "snapshot" : null)
  const live = LIVE_STATUS.has(detail?.status ?? target.status ?? "")

  // ── 执行详情：运行中 3s 轮询，终态 15s（与运行窗同律）──
  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    setRootCurrent(null)
    setActiveRef(null)
    setSource("snapshot")
    setQuery("")
    setStepped(false)
    setChildren({})
    inFlightRef.current.clear()
    currentAttemptedRef.current = null
  }, [workspaceId, executionId])

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchExecutionDetail(workspaceId, executionId)
        .then((data) => {
          if (!alive) return
          setDetail(data)
          setDetailError(null)
        })
        .catch((err: unknown) => {
          if (alive) setDetailError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const timer = window.setInterval(load, live ? 3_000 : 15_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [workspaceId, executionId, live])

  // 子流快照是运行中长出来的：SSE runtime_node_added 立即重试，不等下一轮轮询。
  useEffect(() => {
    if (!workspaceId || !executionId) return
    return subscribeSSE(
      `${getServerUrl()}/api/workspaces/${workspaceId}/executions/events`,
      "runtime_node_added",
      (event) => {
        try {
          const data = JSON.parse(event.data) as { executionId?: string }
          if (data.executionId === executionId) setRuntimeVersion((v) => v + 1)
        } catch {
          /* ignore malformed event */
        }
      },
    )
  }, [workspaceId, executionId])

  const refs = useMemo<SubWorkflowRef[]>(
    () => collectSubWorkflowRefs(rootYaml, steps as StepExecution[] | null, executionId),
    [rootYaml, steps, executionId],
  )

  // ── 子流内容：动态子流取执行快照；静态子流取工作区当前定义（它没有运行快照）──
  useEffect(() => {
    let alive = true
    const toFetch = refs.filter((ref) => {
      if (inFlightRef.current.has(ref.ref)) return false
      const prev = childrenRef.current[ref.ref]
      return !prev || prev.status === "missing" || prev.status === "error"
    })
    for (const ref of toFetch) {
      inFlightRef.current.add(ref.ref)
      setChildren((prev) => ({ ...prev, [ref.ref]: { status: "loading" } }))
      const opts = ref.isDynamic ? { executionId, isDynamic: true } : undefined
      fetchWorkflowContent(workspaceId, ref.ref, opts)
        .then((res) => {
          if (!alive) return
          setChildren((prev) => ({
            ...prev,
            [ref.ref]: res?.content
              ? { status: "ready", content: res.content }
              : { status: "missing" },
          }))
        })
        .catch(() => {
          if (alive) setChildren((prev) => ({ ...prev, [ref.ref]: { status: "error" } }))
        })
        .finally(() => {
          inFlightRef.current.delete(ref.ref)
        })
    }
    return () => {
      alive = false
    }
  }, [refs, runtimeVersion, workspaceId, executionId])

  // ── 主工作流的「当前定义」后台加载：用于差异条 + 一键切换 ──
  useEffect(() => {
    if (!rootRef) return
    const key = `${workspaceId}:${rootRef}`
    if (currentAttemptedRef.current === key) return
    currentAttemptedRef.current = key
    let alive = true
    setRootCurrent({ status: "loading" })
    fetchWorkflowContent(workspaceId, rootRef)
      .then((res) => {
        if (!alive) return
        setRootCurrent(res?.content ? { status: "ready", content: res.content } : { status: "missing" })
      })
      .catch(() => {
        if (alive) setRootCurrent({ status: "error" })
      })
    return () => {
      alive = false
    }
  }, [workspaceId, rootRef])

  // 子流从树上消失（rerun / 迭代变化）→ 退回主工作流。
  useEffect(() => {
    if (!activeRef) return
    if (!refs.some((ref) => ref.ref === activeRef)) {
      setActiveRef(null)
      setSource("snapshot")
    }
  }, [refs, activeRef])

  const activeInfo = activeRef ? refs.find((ref) => ref.ref === activeRef) ?? null : null
  const isRoot = !activeInfo
  const activeKey = activeInfo?.ref ?? ROOT_KEY
  const dynamic = activeInfo?.isDynamic ?? false

  const rootLoading = !detail && !detailError
  const rootSnapshotState: LoadState = rootLoading
    ? { status: "loading" }
    : { status: rootYaml ? "ready" : "missing", content: rootYaml }

  const snapshotState: LoadState | null = isRoot
    ? rootSnapshotState
    : dynamic
      ? children[activeKey] ?? { status: "loading" }
      : null

  const currentState: LoadState | null = isRoot
    ? rootCurrent ?? { status: "loading" }
    : dynamic
      ? null
      : children[activeKey] ?? { status: "loading" }

  // 动态子流还没生成时，不能停留在它上面。
  const snapshotStatus = snapshotState?.status ?? null
  useEffect(() => {
    if (activeRef && activeInfo && dynamic && snapshotStatus !== "ready") {
      setActiveRef(null)
      setSource("snapshot")
    }
  }, [activeRef, activeInfo, dynamic, snapshotStatus])

  const canSnapshot = isRoot || dynamic
  const canCurrent = !dynamic && currentState?.status === "ready"
  const effectiveSource: "snapshot" | "current" =
    source === "current" && canCurrent ? "current" : "snapshot"

  const snapshotContent = snapshotState?.content ?? ""
  const currentContent = currentState?.status === "ready" ? currentState.content ?? "" : ""
  const displayText = effectiveSource === "current" ? currentContent : snapshotContent
  const displayReady =
    effectiveSource === "current"
      ? currentState?.status === "ready"
      : snapshotState?.status === "ready"

  const rootName = workflowDisplayName(rootYaml, rootRef)
  const entryName = isRoot ? rootName : activeInfo?.label ?? activeKey

  const lines = useMemo(() => splitYamlLines(displayText), [displayText])
  const blockFlags = useMemo(() => blockScalarFlags(lines), [lines])
  const outline = useMemo(() => extractYamlNodes(lines), [lines])
  const matches = useMemo(() => findYamlMatches(lines, query), [lines, query])

  const matchesByLine = useMemo(() => {
    const map = new Map<number, YamlMatch[]>()
    for (const match of matches) {
      const list = map.get(match.line)
      if (list) list.push(match)
      else map.set(match.line, [match])
    }
    return map
  }, [matches])

  useEffect(() => {
    setCurrentMatch(0)
    setStepped(false)
  }, [query, activeKey, effectiveSource])

  useEffect(() => {
    setCurrentMatch((index) =>
      matches.length === 0 ? 0 : Math.min(index, matches.length - 1),
    )
  }, [matches.length])

  useEffect(() => {
    if (!query || matches.length === 0) return
    const element = scrollRef.current?.querySelector(`[data-match-index="${currentMatch}"]`)
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [currentMatch, query, matches.length])

  const stepMatch = useCallback(
    (direction: number) => {
      if (matches.length === 0) return
      setStepped(true)
      setCurrentMatch((index) => (index + direction + matches.length) % matches.length)
    },
    [matches.length],
  )

  const diffLines = useMemo(() => {
    if (!isRoot || rootSnapshotSource !== "snapshot") return new Set<number>()
    if (rootCurrent?.status !== "ready" || !rootCurrent.content || !rootYaml) return new Set<number>()
    return diffLineNumbers(rootYaml, rootCurrent.content)
  }, [isRoot, rootSnapshotSource, rootCurrent, rootYaml])

  const hasDrift =
    isRoot &&
    rootSnapshotSource === "snapshot" &&
    !!rootYaml &&
    currentState?.status === "ready" &&
    !!currentContent &&
    rootYaml !== currentContent

  const fallbackSource =
    isRoot && rootSnapshotSource && rootSnapshotSource !== "snapshot" ? rootSnapshotSource : null

  // 来源切换只在「两边都取得到、而且真的不一样」时才有意义。
  // 相同 → 隐藏；动态子流只有快照、静态子流只有工作区定义 → 也隐藏。
  const showSourceSwitch =
    canSnapshot &&
    canCurrent &&
    !!snapshotContent &&
    !!currentContent &&
    snapshotContent !== currentContent

  useEffect(() => {
    if (isRoot && !showSourceSwitch && source === "current") setSource("snapshot")
  }, [isRoot, showSourceSwitch, source])

  const treeRows = useMemo<TreeRow[]>(() => {
    const rootLines = rootYaml ? countYamlLines(rootYaml) : null
    const rows: TreeRow[] = [
      {
        key: ROOT_KEY,
        name: rootName,
        dynamic: false,
        child: false,
        status: rootSnapshotState.status,
        kind: "",
        pending: false,
        lines: rootLines,
        title: "主工作流 · 点击查看",
        ready: rootSnapshotState.status === "ready",
      },
    ]
    for (const ref of refs) {
      const state = children[ref.ref]
      const status = state?.status ?? "loading"
      const ready = status === "ready"
      let kind: string
      let pending = false
      if (ref.isDynamic) {
        if (status === "missing") {
          // 终态执行上仍缺快照 = 这次没有生成（节点失败/跳过），不是「正在生成」。
          kind = live ? "生成中…" : "未生成"
          pending = true
        } else if (status === "error") {
          kind = "读取失败"
        } else if (ready) {
          kind = "动态"
        } else {
          kind = "读取中…"
        }
      } else if (status === "missing") {
        kind = "未找到"
      } else if (status === "error") {
        kind = "读取失败"
      } else if (ready) {
        kind = "子流"
      } else {
        kind = "读取中…"
      }
      rows.push({
        key: ref.ref,
        name: ref.label,
        dynamic: ref.isDynamic,
        child: true,
        status,
        kind,
        pending,
        lines: ready && state?.content ? countYamlLines(state.content) : null,
        title: ref.isDynamic
          ? pending
            ? live
              ? `${ref.nodeId} 尚未生成 —— 节点还在运行，快照落盘后出现在这里`
              : `${ref.nodeId} 这次运行没有生成动态子流快照`
            : "dynamic_sub_workflow 运行时生成的子工作流 · 点击查看"
          : "静态子工作流 · 点击查看工作区定义",
        ready,
      })
    }
    return rows
  }, [rootName, rootSnapshotState.status, rootYaml, refs, children, live])

  const subtitle = useMemo(() => {
    if (!isRoot) {
      if (dynamic) return `动态子工作流 · ${rootName} › ${entryName} · 运行时生成`
      return `子工作流 · ${rootName} › ${entryName}`
    }
    if (effectiveSource === "current") return rootRef ?? "当前定义"
    const coord = [
      target.phaseIndex != null ? `P${target.phaseIndex}` : null,
      target.roundIndex != null ? `R${target.roundIndex}` : null,
    ]
      .filter(Boolean)
      .join(" · ")
    return [coord, shortExec(executionId)].filter(Boolean).join(" · ")
  }, [isRoot, dynamic, rootName, entryName, effectiveSource, rootRef, target.phaseIndex, target.roundIndex, executionId])

  const sourceLabel = (() => {
    if (dynamic) return "动态快照 · 运行时生成"
    if (!isRoot) return "当前定义"
    if (effectiveSource === "current") return "当前定义 · 读取于刚刚"
    if (fallbackSource === "workspace") return "回退 · 工作区定义"
    if (fallbackSource === "builtin") return "回退 · 内置定义"
    const time = formatDateTime(detail?.started_at)
    return time ? `运行快照 · ${time}` : "运行快照"
  })()

  const matchCountLabel = query
    ? matches.length === 0
      ? "无匹配"
      : stepped
        ? `${currentMatch + 1}/${matches.length}`
        : `${matches.length} 处`
    : ""

  const selectWorkflow = (key: string, row: TreeRow) => {
    if (!row.ready) return
    setActiveRef(key === ROOT_KEY ? null : key)
    setSource(row.dynamic || key === ROOT_KEY ? "snapshot" : "current")
    setQuery("")
    setStepped(false)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }

  const setSourceSafe = (next: "snapshot" | "current") => {
    if (next === "current" && (dynamic || !canCurrent)) {
      toast(dynamic ? "动态子工作流只存在运行快照" : "工作区没有对应的当前定义")
      return
    }
    if (next === "snapshot" && !canSnapshot) return
    if (next === source) return
    setSource(next)
    setQuery("")
    setStepped(false)
  }

  const jumpToLine = (line: number) => {
    const element = scrollRef.current?.querySelector(`[data-line="${line}"]`)
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center", behavior: "smooth" })
    }
    setFlashLine(line)
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlashLine(null), 900)
  }

  const copyAll = async () => {
    if (!displayReady) return
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(displayText)
      } else {
        const area = document.createElement("textarea")
        area.value = displayText
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.appendChild(area)
        area.select()
        document.execCommand("copy")
        area.remove()
      }
      toast.success("已复制 YAML")
    } catch {
      toast.error("复制失败")
    }
  }

  const download = () => {
    if (!displayReady) return
    const blob = new Blob([displayText], { type: "text/yaml;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${safeFilename(entryName)}${dynamic || effectiveSource === "snapshot" ? ".snapshot" : ""}.yaml`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
    toast.success(`已下载 ${anchor.download}`)
  }

  // ⌘/Ctrl+F 聚焦搜索；Esc 交给 useEscapeClose（与系统窗口同一套栈，失焦时让给下层窗口）。
  useEffect(() => {
    if (minimized) return
    const onKeyDown = (event: KeyboardEvent) => {
      const commandF = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f"
      if (!commandF) return
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [minimized])

  useEffect(() => {
    const onResize = () => {
      setRect((prev) => (maximized ? maximizedRect() : clampRect(prev, viewportSize())))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [maximized])

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  const handleDragStart = () => {
    const layer = dragLayerRef.current
    if (!layer) return
    layer.style.transition = "none"
    layer.style.willChange = "transform"
  }

  const handleDragMove = (dx: number, dy: number) => {
    if (dragLayerRef.current) {
      dragLayerRef.current.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
    }
  }

  const handleDragEnd = (dx: number, dy: number) => {
    const layer = dragLayerRef.current
    if (layer) {
      layer.style.transform = ""
      layer.style.willChange = ""
      layer.style.transition = ""
    }
    const next = clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewportSize())
    if (positionerRef.current) {
      positionerRef.current.style.left = `${next.x}px`
      positionerRef.current.style.top = `${next.y}px`
    }
    setRect(next)
  }

  const handleResizeStart = (direction: ResizeDirection) => {
    resizeStartRef.current = { rect, direction }
    resizeLastRef.current = rect
  }

  const handleResizeMove = (dx: number, dy: number) => {
    const start = resizeStartRef.current
    if (!start) return
    const next = resizeRect(start.rect, start.direction, dx, dy, viewportSize())
    resizeLastRef.current = next
    const element = positionerRef.current
    if (element) {
      element.style.left = `${next.x}px`
      element.style.top = `${next.y}px`
      element.style.width = `${next.w}px`
      element.style.height = `${next.h}px`
    }
  }

  const handleResizeEnd = () => {
    const next = resizeLastRef.current
    resizeStartRef.current = null
    if (next) setRect(next)
  }

  const toggleMaximize = () => {
    if (maximized) {
      setMaximized(false)
      setRect(restoreRect ? clampRect(restoreRect, viewportSize()) : rect)
      setRestoreRect(null)
      return
    }
    setRestoreRect(rect)
    setMaximized(true)
    setRect(maximizedRect())
  }

  if (typeof document === "undefined") return null

  const windowBody = (
    <div
      ref={positionerRef}
      role="dialog"
      aria-label="工作流 YAML"
      data-testid="workflow-yaml-window"
      className="pointer-events-auto fixed z-[120]"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDownCapture={() => setFocused(true)}
    >
      <div ref={dragLayerRef} className="h-full w-full">
        <div
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-xl border-[1.5px] border-pop-bd bg-pop-paper",
            focused ? "shadow-pop-lg" : "shadow-pop",
          )}
        >
          <WindowTitlebar
            title={`YAML · ${entryName}`}
            focused={focused}
            canDrag={!maximized}
            onClose={onClose}
            onMinimize={() => setMinimized(true)}
            onToggleMaximize={toggleMaximize}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
          />

          <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] bg-pop-paper/60 px-3 py-1.5">
            <span className="grid size-[22px] shrink-0 place-items-center rounded-md border border-pop-cyan/35 bg-pop-cyan/[0.07] font-mono text-[9px] font-black tracking-[-0.08em] text-pop-cyan">
              &lt;/&gt;
            </span>
            <div
              data-testid="yaml-subtitle"
              className="min-w-0 flex-1 truncate font-mono text-[9.5px] tabular-nums text-pop-dim"
            >
              {subtitle}
            </div>
            {showSourceSwitch && (
              <div
                role="group"
                aria-label="YAML 来源"
                className="flex shrink-0 gap-0.5 rounded-lg bg-white/[0.06] p-0.5"
              >
                <button
                  type="button"
                  data-testid="yaml-source-snapshot"
                  aria-pressed={effectiveSource === "snapshot"}
                  title="本次执行落盘的 YAML 快照"
                  onClick={() => setSourceSafe("snapshot")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[10px] transition-colors",
                    effectiveSource === "snapshot"
                      ? "bg-white/[0.13] text-pop-ink"
                      : "text-pop-dim hover:text-pop-ink",
                  )}
                >
                  运行快照
                </button>
                <button
                  type="button"
                  data-testid="yaml-source-current"
                  aria-pressed={effectiveSource === "current"}
                  title="工作区当前 workflows/ 下的定义"
                  onClick={() => setSourceSafe("current")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[10px] transition-colors",
                    effectiveSource === "current"
                      ? "bg-white/[0.13] text-pop-ink"
                      : "text-pop-dim hover:text-pop-ink",
                  )}
                >
                  当前定义
                </button>
              </div>
            )}
          </div>

          {fallbackSource && effectiveSource === "snapshot" && (
        <div
          data-testid="yaml-fallback-banner"
          className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-pop-amber/[0.045] px-3 py-1.5 font-mono text-[10px] text-pop-dim"
        >
          <span className="shrink-0 rounded-full border border-pop-amber/40 bg-pop-amber/[0.06] px-2 py-[1px] text-[9px] font-bold text-pop-amber">
            未找到运行快照
          </span>
          <span className="min-w-0 truncate">
            本次执行没有落盘 YAML，当前展示的是
            {fallbackSource === "workspace" ? "工作区当前定义" : "内置资源定义"}
          </span>
        </div>
      )}

      {hasDrift && (
        <div
          data-testid="yaml-diff-banner"
          className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] bg-pop-amber/[0.045] px-3 py-1.5 font-mono text-[10px] text-pop-dim"
        >
          <span className="shrink-0 rounded-full border border-pop-amber/40 bg-pop-amber/[0.06] px-2 py-[1px] text-[9px] font-bold text-pop-amber">
            {effectiveSource === "snapshot" ? "与当前定义有差异" : "与运行快照有差异"}
          </span>
          <span className="min-w-0 truncate">
            {effectiveSource === "snapshot"
              ? "这是本次运行使用的快照；工作区定义已更新"
              : "正在看工作区的当前定义；本次运行用的是旧快照"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="shrink-0 text-[10px] text-pop-cyan underline underline-offset-2 hover:text-[#8AEAF0]"
            onClick={() => setSourceSafe(effectiveSource === "snapshot" ? "current" : "snapshot")}
          >
            {effectiveSource === "snapshot" ? "查看当前定义 →" : "回到运行快照 →"}
          </button>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
        <label className="flex w-[300px] max-w-[52%] items-center gap-1.5 rounded-[7px] border border-pop-bd bg-pop-inset px-2 py-1 focus-within:border-pop-amber/45">
          <Search className="size-3 shrink-0 text-pop-dim/80" />
          <input
            ref={searchRef}
            data-testid="yaml-search"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                stepMatch(event.shiftKey ? -1 : 1)
              }
            }}
            placeholder="搜索 YAML（⌘F）"
            autoComplete="off"
            spellCheck={false}
            aria-label="搜索 YAML"
            className="min-w-0 flex-1 bg-transparent font-mono text-[10.5px] text-pop-ink outline-none placeholder:text-pop-dim/60"
          />
          <span
            data-testid="yaml-match-count"
            className="whitespace-nowrap font-mono text-[9px] tabular-nums text-pop-dim"
          >
            {matchCountLabel}
          </span>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="yaml-wrap"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            className={cn(
              "rounded-md border border-transparent px-2 py-1 font-mono text-[10px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink",
              wrap && "border-pop-green/35 bg-pop-green/[0.07] text-pop-green",
            )}
          >
            自动换行
          </button>
          <button
            type="button"
            data-testid="yaml-copy"
            disabled={!displayReady}
            onClick={() => void copyAll()}
            className="rounded-md border border-transparent px-2 py-1 font-mono text-[10px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            复制
          </button>
          <button
            type="button"
            data-testid="yaml-download"
            disabled={!displayReady}
            onClick={download}
            className="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 font-mono text-[10px] text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="size-3" />
            下载
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[196px] shrink-0 flex-col border-r border-white/[0.07] bg-[#131318]/55">
          <div className="shrink-0 px-2.5 pb-1 pt-2.5 font-mono text-[9.5px] font-extrabold text-pop-ink">
            工作流
          </div>
          <div className="shrink-0 border-b border-white/[0.06] px-1.5 pb-2">
            {treeRows.map((row) => (
              <button
                key={row.key}
                type="button"
                data-testid="yaml-workflow-row"
                data-ref={row.key}
                data-dynamic={row.dynamic ? "true" : "false"}
                data-status={row.status}
                data-active={(row.key === ROOT_KEY ? isRoot : activeKey === row.key) ? "true" : "false"}
                disabled={!row.ready}
                title={row.title}
                onClick={() => selectWorkflow(row.key, row)}
                className={cn(
                  "relative flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[10px] transition-colors",
                  row.key === ROOT_KEY ? (isRoot ? "text-pop-ink" : "text-pop-dim") : activeKey === row.key ? "text-pop-ink" : "text-pop-dim",
                  row.key === ROOT_KEY && isRoot && "bg-pop-cyan/[0.08] shadow-[inset_0_0_0_1px_rgba(79,209,217,0.28)]",
                  row.key !== ROOT_KEY && activeKey === row.key && "bg-pop-cyan/[0.08] shadow-[inset_0_0_0_1px_rgba(79,209,217,0.28)]",
                  row.ready && "hover:bg-white/[0.06] hover:text-pop-ink",
                  !row.ready && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-pop-dim",
                  row.child && "pl-[18px]",
                )}
              >
                {row.child && (
                  <span className="absolute left-2 font-mono text-[9px] text-[#4A4C56]">└</span>
                )}
                <span
                  className={cn(
                    "size-[7px] shrink-0 rounded-[2px]",
                    row.dynamic ? "rotate-45 bg-pop-pink" : "bg-pop-ink",
                  )}
                />
                <span className="truncate">{row.name}</span>
                {row.kind && (
                  <span
                    className={cn(
                      "shrink-0 rounded-[3px] border px-1 text-[8px] leading-[1.5]",
                      row.pending
                        ? "border-pop-amber/35 bg-pop-amber/[0.06] text-pop-amber"
                        : row.dynamic
                          ? "border-pop-pink/30 bg-pop-pink/[0.06] text-pop-pink"
                          : "border-pop-purple/30 bg-pop-purple/[0.06] text-pop-purple",
                    )}
                  >
                    {row.kind}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[8.5px] tabular-nums text-pop-dim/50">
                  {row.lines ?? ""}
                </span>
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 px-2.5 pb-1.5 pt-2.5 font-mono text-[9.5px] font-extrabold text-pop-ink">
            节点
            <span className="ml-auto font-medium tabular-nums text-pop-dim">{outline.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
            {outline.map((node) => (
              <button
                key={`${node.line}:${node.id}`}
                type="button"
                data-testid="yaml-node-outline"
                data-goto={node.line}
                title={`${node.id}${node.type ? ` · ${node.type}` : ""} · 第 ${node.line} 行`}
                onClick={() => jumpToLine(node.line)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-[10px] text-pop-dim hover:bg-white/[0.06] hover:text-pop-ink"
              >
                <span
                  className="size-[7px] shrink-0 rounded-[2px]"
                  style={{ background: NODE_TYPE_COLORS[node.type] ?? "#9698A3" }}
                />
                <span className="truncate">{node.id}</span>
                <span className="ml-auto shrink-0 text-[8.5px] tabular-nums text-pop-dim/50">
                  {node.line}
                </span>
              </button>
            ))}
          </div>
          <div className="shrink-0 border-t border-white/[0.05] px-2.5 py-1.5 font-mono text-[8.5px] leading-4 text-pop-dim/60">
            从 YAML 解析 · 点击跳到节点定义
          </div>
        </aside>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-pop-inset">
          {detailError ? (
            <div className="p-4 font-mono text-[11px] text-pop-red">{detailError}</div>
          ) : !detail ? (
            <div className="p-4 font-mono text-[11px] text-pop-dim">读取执行…</div>
          ) : !displayReady ? (
            <div className="p-4 font-mono text-[11px] text-pop-dim">
              {snapshotState?.status === "missing" || currentState?.status === "missing"
                ? "这份工作流没有可展示的 YAML。"
                : "读取工作流 YAML…"}
            </div>
          ) : (
            <div
              data-testid="yaml-code"
              className={cn(
                "whitespace-pre py-2.5 pr-0 font-mono text-[11.5px] leading-[1.78]",
                wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]",
              )}
            >
              {lines.map((raw, index) => {
                const tokens = highlightYamlLine(raw, blockFlags[index] ?? false)
                const display = applyMatchHighlights(
                  tokens,
                  matchesByLine.get(index) ?? [],
                  currentMatch,
                )
                const lineNumber = index + 1
                const isDiff = diffLines.has(lineNumber)
                return (
                  <div
                    key={index}
                    data-testid="yaml-line"
                    data-line={lineNumber}
                    className={cn(
                      "flex min-h-[20px] pr-6 hover:bg-white/[0.028]",
                      isDiff && "bg-pop-amber/[0.05] shadow-[inset_2px_0_0_var(--pop-amber)]",
                      flashLine === lineNumber && "bg-pop-cyan/[0.16]",
                    )}
                  >
                    <span className="w-[46px] shrink-0 select-none pr-3.5 text-right text-[#43454F]">
                      {lineNumber}
                    </span>
                    <span className="min-w-0">
                      {display.length === 0 ? (
                        " "
                      ) : (
                        display.map((token, tokenIndex) =>
                          token.hit ? (
                            <mark
                              key={tokenIndex}
                              data-match-index={token.current ? currentMatch : undefined}
                              className={cn(
                                "rounded-[2px] px-px",
                                token.current
                                  ? "bg-pop-amber text-pop-bg"
                                  : "bg-pop-amber/[0.24] text-pop-ink",
                              )}
                            >
                              {token.text}
                            </mark>
                          ) : (
                            <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                              {token.text}
                            </span>
                          ),
                        )
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-1.5 border-t border-white/[0.07] bg-pop-paper/50 px-2.5 py-1.5 font-mono text-[9px] text-pop-dim/80">
        <span data-testid="yaml-source-label">{sourceLabel}</span>
        <span className="text-pop-dim/35">·</span>
        <span data-testid="yaml-line-count">{displayReady ? `${lines.length} 行` : "— 行"}</span>
        <span className="text-pop-dim/35">·</span>
        <span>UTF-8</span>
        <span className="text-pop-dim/35">·</span>
        <span className="text-pop-green/85">只读</span>
        <span className="flex-1" />
        <span className="text-pop-dim/55">Esc 关闭 · ⌘F 搜索</span>
      </footer>
        </div>
      </div>

      {focused && !maximized && (
        <WindowResizeHandles
          onStart={handleResizeStart}
          onMove={handleResizeMove}
          onEnd={handleResizeEnd}
        />
      )}
    </div>
  )

  if (minimized) {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-4 right-4 z-[120]">
        <button
          type="button"
          data-testid="yaml-restore"
          onClick={() => {
            setMinimized(false)
            setFocused(true)
          }}
          className="inline-flex items-center gap-2 rounded-full border border-pop-bd bg-pop-paper px-3 py-2 font-mono text-[11px] font-bold text-pop-ink shadow-pop-lg hover:bg-pop-idle"
        >
          <span className="font-mono text-[9px] text-pop-cyan">&lt;/&gt;</span>
          YAML · {entryName}
        </button>
      </div>,
      document.body,
    )
  }

  return createPortal(windowBody, document.body)
}
