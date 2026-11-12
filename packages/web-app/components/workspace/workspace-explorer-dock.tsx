'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Y from 'yjs'
import {
  Activity,
  Archive,
  Ban,
  BarChart3,
  Bug,
  Check,
  ClipboardCheck,
  Clock,
  Copy,
  FileText,
  FolderTree,
  GitCompare,
  LayoutGrid,
  Package,
  Pause,
  Pencil,
  Play,
  Square,
  Upload,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { FileNode } from '@/lib/types'
import {
  fetchFileContent,
  fetchWorkspaceRuns,
  getWorkspace,
  openWorkspaceDirectory,
  saveFileEntry,
  type WorkspaceRun,
} from '@/lib/api-client'
import { listSessionSubagents, type SubagentRunSummary } from '@/lib/agent/api'
import { listSessionDebugTurns } from '@/lib/agent/debug-api'
import { useYDoc, useYMap } from '@/lib/yjs-provider'
import { SidebarFileTree, ymapToFileNodes } from '@/components/workspace/sidebar-file-tree'
import { TextEditorTab, getYText } from '@/components/workspace/text-editor-tab'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { WindowResizeHandles } from '@/components/shell/window-resize-handles'
import { fitPanelFrame, resizePanelFrame, type PanelFrame, type PanelFrameLimits } from '@/components/workspace/dock-panel-geometry'
import type { ResizeDirection } from '@/lib/window-geometry'
import { useEscapeClose } from '@/lib/escape-stack'
import type { TaskView } from '@/lib/tasks-api'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from '@/components/chat-workbench/task-window-types'
import {
  InspectorActivityPanel,
  type ActivitySnapshot,
} from '@/components/chat-workbench/inspector-activity'
import { RunPicker, isLiveRun } from '@/components/chat-workbench/run-picker'
import { SubagentListPane } from '@/components/chat-workbench/subagent-list-pane'
import { cn } from '@/lib/utils'
import { useDockLabelsVisible } from '@/hooks/use-dock-labels'

/** 舱 dock 入口（原型 dock-btn）：id/label/icon + 开合态 + 点击开窗。 */
export interface CabinDockModule {
  id: string
  label: string
  icon: LucideIcon
  active?: boolean
  attention?: boolean
  badge?: number
  badgeTone?: 'amber' | 'green' | 'purple' | 'cyan'
  marker?: 'open' | 'minimized'
  onClick: () => void
}

export interface WorkspaceExplorerDockProps {
  workspaceId: string | null
  workspaceName?: string
  task?: TaskView | null
  taskWindows?: TaskWindowMap
  /** 舱模块段（Cabin P2，原型 DOCK_MOD）：常驻 RES 之后的一组入口 + 「更多模块」
   *  溢出 grid。缺省 = 桌面原样，不渲染舱段。 */
  cabinModules?: CabinDockModule[]
  cabinMoreModules?: CabinDockModule[]
  /** 常驻「消耗」按钮的窗口状态（任务账本或会话账本，同一扇窗）。 */
  usageWindow?: TaskWindowRecord | null
  onOpenUsage?: () => void
  /** 常驻「调试」按钮的窗口状态（per-turn SDK inspector）。 */
  debugWindow?: TaskWindowRecord | null
  onOpenDebug?: () => void
  /** 当前聊天会话 —— 调试徽标（异常轮数）取数。 */
  debugSessionId?: string | null
  /** 消息数 / 流式状态变化时刷新调试徽标。 */
  debugRefreshKey?: string | number
  /** 子代理入口取数的会话（作业坞「子代理」）。 */
  subagentSessionId?: string | null
  /** 子代理详情窗状态（坞上的开/最小化标记）。 */
  subagentWindow?: TaskWindowRecord | null
  /** 子代理列表点一条 → 打开详情窗。 */
  onOpenSubagent?: (run: SubagentRunSummary) => void
  onOpenTaskModule?: (module: TaskModule) => void
  /** 运行列表里点了一条 → 打开指定执行的运行窗（ChatTab 负责开窗）。 */
  onOpenRun?: (run: WorkspaceRun) => void
  /** 运行列表行尾 </> → 直接看这次运行的 YAML 快照（ChatTab 负责开窗）。 */
  onOpenYaml?: (run: WorkspaceRun) => void
  /** Task action (trigger/pause/resume/abort/reopen/retry_archive/accept…). */
  onTaskAction?: (action: string) => void
  activity: ActivitySnapshot
  /** ChatTab 注入的任务维度控件（绑定项目 dock 形态，2026-10-28）：渲染在
   *  任务分隔线之后、模块图标之前。 */
  taskProject?: ReactNode
  /** Chat sidebar width (0 when collapsed) — the editor panel sizes around it. */
  sidebarWidth?: number
  /** 分屏：每栏变窄，坞强制收成图标栏（不改用户的文字标签偏好）。 */
  compact?: boolean
  className?: string
}

interface EditorFile {
  path: string
  name: string
  extension?: string
}

type Pane = 'files' | 'activity' | 'run' | 'subagents'

const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'json', 'yaml', 'yml', 'md', 'txt', 'css', 'scss',
  'html', 'py', 'java', 'kt', 'go', 'rs', 'sh', 'toml', 'xml', 'sql', 'mjs', 'cjs',
])

function fileExt(name: string): string | undefined {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : undefined
}

function tabsKey(workspaceId: string) {
  return `octopus.chat.editorTabs.v1:${workspaceId}`
}

const EDITOR_MIN_WIDTH = 320
const EDITOR_MIN_HEIGHT = 220
/** Dock footprint (p-1.5 + border) — icon-only vs. icon + permanent label. */
const DOCK_WIDTH_ICON = 48
const DOCK_WIDTH_LABEL = 59
const PANE_WIDTH = 300
const PANE_MIN_WIDTH = 240
const PANE_MIN_HEIGHT = 180
const RUN_PANE_WIDTH = 384
const SUBAGENT_PANE_WIDTH = 360
const GAP = 8
const FLOAT_MARGIN = 12
/** 浮窗离聊天栏左沿 / 底沿的留白。 */
const PANEL_MARGIN = 24
const SIDEBAR_DEFAULT_WIDTH = 236

/** 各 pane 的默认宽度（用户拖过之后以 paneFrames 为准）。 */
const DEFAULT_PANE_WIDTH: Record<Pane, number> = {
  files: PANE_WIDTH,
  activity: PANE_WIDTH,
  run: RUN_PANE_WIDTH,
  subagents: SUBAGENT_PANE_WIDTH,
}

/** 右侧锚定的浮窗只留西/北/南可拖（东边贴着作业坞，边界拖拽走 pane 自己的西边）。 */
const PANEL_RESIZE_DIRECTIONS: readonly ResizeDirection[] = ['w', 'n', 's', 'nw', 'sw']

const MODULE_ROWS: Array<{ id: TaskModule; label: string; icon: typeof FileText }> = [
  // workflow-dev 任务专用（2026-11-06）：DAG + YAML，放在运行前。
  { id: 'workflow', label: '工作流', icon: Workflow },
  // 2026-11-04 用户：运行提到「项目」下面第一个。
  { id: 'run', label: '运行', icon: Play },
  { id: 'plan', label: '规格', icon: FileText },
  { id: 'changes', label: '变更', icon: GitCompare },
  { id: 'acceptance', label: '验收', icon: ClipboardCheck },
  { id: 'artifacts', label: '产物', icon: Package },
  { id: 'archive', label: '归档', icon: Archive },
]

const TASK_STATUS_META: Record<string, {
  label: string
  badge: string
  icon: LucideIcon
  pulse?: boolean
}> = {
  draft: { label: '草稿', badge: 'bg-pop-cyan text-pop-bg', icon: Pencil },
  ready: { label: '待执行', badge: 'bg-pop-cyan text-pop-bg', icon: Play },
  running: { label: '运行中', badge: 'bg-pop-green text-pop-bg', icon: Play, pulse: true },
  paused: { label: '已暂停', badge: 'bg-pop-amber text-pop-bg', icon: Pause },
  awaiting_review: { label: '待验收', badge: 'bg-pop-amber text-pop-bg', icon: ClipboardCheck },
  awaiting_archive: { label: '待归档', badge: 'bg-pop-pink text-pop-bg', icon: Archive },
  archiving: { label: '归档中', badge: 'bg-pop-amber text-pop-bg', icon: Archive },
  done: { label: '已完成', badge: 'bg-pop-green text-pop-bg', icon: Check },
  failed: { label: '失败', badge: 'bg-pop-red text-pop-bg', icon: X },
  aborted: { label: '中止', badge: 'bg-pop-amber text-pop-bg', icon: Ban },
}

function loadTabs(workspaceId: string): { tabs: EditorFile[]; active: string | null } {
  try {
    const parsed = JSON.parse(localStorage.getItem(tabsKey(workspaceId)) ?? 'null') as
      | { tabs?: EditorFile[]; active?: string | null }
      | null
    return { tabs: parsed?.tabs ?? [], active: parsed?.active ?? null }
  } catch {
    return { tabs: [], active: null }
  }
}

/**
 * macOS-style vertical Dock on the right. Icons carry a permanent ≤3-char
 * label under them by default (设置 → 外观 can hide it, back to icon-only
 * with hover tooltips). A file/activity pane opens to its left (closed by
 * default); module icons open task windows directly. The editor window
 * aligns its top to the Dock.
 */
export function WorkspaceExplorerDock({
  workspaceId,
  workspaceName,
  task,
  taskWindows,
  cabinModules,
  cabinMoreModules,
  usageWindow,
  onOpenUsage,
  debugWindow,
  onOpenDebug,
  debugSessionId,
  debugRefreshKey,
  subagentSessionId,
  subagentWindow,
  onOpenSubagent,
  onOpenTaskModule,
  onOpenRun,
  onOpenYaml,
  onTaskAction,
  activity,
  taskProject,
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  compact = false,
  className,
}: WorkspaceExplorerDockProps) {
  const [pane, setPane] = useState<Pane | null>(null)
  const [tabs, setTabs] = useState<EditorFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [contents, setContents] = useState<Record<string, string>>({})
  const [debugAnomalies, setDebugAnomalies] = useState(0)
  // 运行面板的数据源（2026-11-02）：一次轮询同时供「进行中」列表与坞徽标。
  // 只读 DB 读模型（重启后仍在），与活动面板的全局队列互不从属。
  const [runs, setRuns] = useState<WorkspaceRun[]>([])
  useEffect(() => {
    if (!workspaceId) {
      setRuns([])
      return
    }
    let alive = true
    const load = async () => {
      try {
        const res = await fetchWorkspaceRuns(workspaceId)
        if (alive) setRuns(Array.isArray(res?.runs) ? res.runs : [])
      } catch { /* 服务端离线：保留上一份快照 */ }
    }
    void load()
    const timer = window.setInterval(load, 3_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [workspaceId])
  const liveRunCount = useMemo(() => runs.filter(isLiveRun).length, [runs])
  // 子代理（2026-11-04）：主 Agent 派生的子代理作业。运行中 2s 刷新，
  // 结束后保留快照 —— 详情窗按 agentId 自己取全量日志。
  const [subagents, setSubagents] = useState<SubagentRunSummary[]>([])
  useEffect(() => {
    if (!subagentSessionId) {
      setSubagents([])
      return
    }
    let alive = true
    const load = async () => {
      try {
        const res = await listSessionSubagents(subagentSessionId)
        if (alive) setSubagents(Array.isArray(res?.runs) ? res.runs : [])
      } catch { /* 服务端离线：保留上一份快照 */ }
    }
    void load()
    const timer = window.setInterval(load, 2_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [subagentSessionId])
  const liveSubagentCount = useMemo(
    () => subagents.filter((run) => run.status === 'running').length,
    [subagents],
  )
  // 文件面板头部显示工作空间真实路径，点击进入系统文件管理器（2026-10-28）。
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  useEffect(() => {
    if (!workspaceId) {
      setWorkspacePath(null)
      return
    }
    let alive = true
    getWorkspace(workspaceId)
      .then((ws) => {
        if (alive) setWorkspacePath((ws as { path?: string } | undefined)?.path ?? null)
      })
      .catch(() => {
        if (alive) setWorkspacePath(null)
      })
    return () => { alive = false }
  }, [workspaceId])
  // 「调试」徽标 = 已记录的异常轮数（interrupted / error）。Best-effort: a
  // failed fetch must never block the dock; the window itself shows the error.
  useEffect(() => {
    if (!debugSessionId || typeof listSessionDebugTurns !== 'function') {
      setDebugAnomalies(0)
      return
    }
    let alive = true
    listSessionDebugTurns(debugSessionId)
      .then((res) => {
        if (!alive) return
        setDebugAnomalies(
          (res.turns ?? []).filter((t) => t.status === 'error' || t.status === 'interrupted').length,
        )
      })
      .catch(() => { if (alive) setDebugAnomalies(0) })
    return () => { alive = false }
  }, [debugSessionId, debugRefreshKey])
  const openDirectory = async () => {
    if (!workspaceId) return
    try {
      await openWorkspaceDirectory(workspaceId)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '打开目录失败')
    }
  }
  // 图标下方的常驻文字（设置 → 外观 可隐藏）。分屏时每栏较窄，强制图标态。
  const showLabels = useDockLabelsVisible() && !compact
  const dockWidth = showLabels ? DOCK_WIDTH_LABEL : DOCK_WIDTH_ICON
  const [cabinMoreOpen, setCabinMoreOpen] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  )
  // ── 浮窗几何（2026-11-09）──────────────────────────────────────────
  // 用户拖过之后才有 frame；缺省宽度按 pane 类型、高度走 CSS（top-14/bottom-3）。
  const [paneFrames, setPaneFrames] = useState<Partial<Record<Pane, PanelFrame>>>({})
  const [editorFrame, setEditorFrame] = useState<PanelFrame | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const panePanelRef = useRef<HTMLDivElement>(null)
  const editorPanelRef = useRef<HTMLDivElement>(null)
  const paneDragRef = useRef<{ direction: ResizeDirection; frame: PanelFrame; editorWidth: number | null } | null>(null)
  const editorDragRef = useRef<{ direction: ResizeDirection; frame: PanelFrame } | null>(null)
  /** 聊天栏可视尺寸（offsetParent）：分屏时只有半栏，不能拿整幅视口当上限。 */
  const [hostSize, setHostSize] = useState<{ width: number; height: number } | null>(null)
  const { doc, connected } = useYDoc(workspaceId ?? '')
  const { map, version } = useYMap(doc, 'fileTree')

  const files = useMemo<FileNode[]>(() => {
    if (!map) return []
    return ymapToFileNodes(map, '')
    // version forces recompute on Y.Map deep updates.
  }, [map, version])

  useEffect(() => {
    if (!workspaceId) {
      setTabs([])
      setActivePath(null)
      setEditorOpen(false)
      setPane(null)
      return
    }
    const restored = loadTabs(workspaceId)
    setTabs(restored.tabs)
    setActivePath(restored.active ?? restored.tabs[restored.tabs.length - 1]?.path ?? null)
    setEditorOpen(false)
    setPane(null)
  }, [workspaceId])

  // Switching tasks starts with the pane closed (files are opt-in).
  useEffect(() => {
    setPane(null)
  }, [task?.id])

  useEffect(() => {
    if (!workspaceId) return
    try {
      localStorage.setItem(tabsKey(workspaceId), JSON.stringify({ tabs, active: activePath }))
    } catch { /* quota */ }
  }, [workspaceId, tabs, activePath])

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 聊天栏尺寸：分屏时浮窗只能占半栏，侧栏拖宽也直接反映在这里。
  useEffect(() => {
    const host = dockRef.current?.offsetParent
    if (!(host instanceof HTMLElement)) return
    const measure = () => setHostSize({ width: host.clientWidth, height: host.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
    // 跨 lg 断点时坞会从 hidden 变可见（offsetParent 才有值），跟着视口宽度重挂。
  }, [viewportWidth])

  // 聊天栏可视尺寸兜底：offsetParent 还没量到时按「视口 − 侧栏」估算。
  const fallbackHostWidth = Math.max(
    EDITOR_MIN_WIDTH + PANEL_MARGIN,
    viewportWidth - (viewportWidth >= 768 ? sidebarWidth : 0),
  )
  const hostWidth = hostSize?.width ?? fallbackHostWidth
  const hostHeight = hostSize?.height ?? 720

  /** 文件列表 pane 的宽度上限：给作业坞和编辑器留出位置。 */
  const paneWidthLimit = Math.max(
    PANE_MIN_WIDTH,
    hostWidth - (FLOAT_MARGIN + dockWidth + GAP) - (editorOpen ? EDITOR_MIN_WIDTH + PANEL_MARGIN : PANEL_MARGIN),
  )
  const paneWidth = pane
    ? Math.min(paneFrames[pane]?.width ?? DEFAULT_PANE_WIDTH[pane], paneWidthLimit)
    : 0
  const editorRight = FLOAT_MARGIN + dockWidth + GAP + paneWidth
  /** 编辑器默认铺满作业坞左侧的可用空间（上限 560），用户拖过之后按 frame。 */
  const editorAutoWidth = Math.max(EDITOR_MIN_WIDTH, Math.min(560, hostWidth - editorRight - PANEL_MARGIN))
  const editorLimits: PanelFrameLimits = {
    minWidth: EDITOR_MIN_WIDTH,
    minHeight: EDITOR_MIN_HEIGHT,
    maxWidth: Math.max(EDITOR_MIN_WIDTH, hostWidth - editorRight - PANEL_MARGIN),
    containerHeight: hostHeight,
  }
  const fittedEditorFrame = editorFrame ? fitPanelFrame(editorFrame, editorLimits) : null
  const editorWidth = fittedEditorFrame?.width ?? editorAutoWidth
  const alivePaneFrame = pane ? paneFrames[pane] : undefined
  const activePaneFrame = alivePaneFrame
    ? fitPanelFrame(alivePaneFrame, {
        minWidth: PANE_MIN_WIDTH,
        minHeight: PANE_MIN_HEIGHT,
        maxWidth: paneWidthLimit,
        containerHeight: hostHeight,
      })
    : null

  useEscapeClose(editorOpen, () => setEditorOpen(false), 30)
  useEscapeClose(!!pane, () => setPane(null), 10)

  const togglePane = (next: Pane) => setPane((prev) => (prev === next ? null : next))

  // ── 浮窗拖拽（纯状态，不再往 DOM 上写 left/top）─────────────────────
  /** pointerdown 时的实测几何（相对 offsetParent，而不是视口）。 */
  const frameOf = (el: HTMLElement | null): PanelFrame | null => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const parentTop = el.offsetParent instanceof HTMLElement
      ? el.offsetParent.getBoundingClientRect().top
      : 0
    return { width: rect.width, height: rect.height, top: rect.top - parentTop }
  }

  const beginPaneResize = (direction: ResizeDirection) => {
    const frame = frameOf(panePanelRef.current)
    if (!frame) return
    paneDragRef.current = { direction, frame, editorWidth: fittedEditorFrame?.width ?? null }
  }
  const movePaneResize = (dx: number, dy: number) => {
    const drag = paneDragRef.current
    if (!drag || !pane) return
    const key = pane
    const next = resizePanelFrame(drag.frame, drag.direction, dx, dy, {
      minWidth: PANE_MIN_WIDTH,
      minHeight: PANE_MIN_HEIGHT,
      maxWidth: paneWidthLimit,
      containerHeight: hostHeight,
    })
    setPaneFrames((prev) => ({ ...prev, [key]: next }))
    // 边界往左 = 文件列表变宽、内容框变窄（左侧不动）；内容框还在自动宽度时
    // 由 editorRight 推导，不用手动跟。拖过之后才有 frame，按反量补宽。
    const delta = drag.frame.width - next.width
    const startEditorWidth = drag.editorWidth
    setEditorFrame((prev) => {
      if (!prev || startEditorWidth == null || !delta) return prev
      const editorMaxWidth = Math.max(
        EDITOR_MIN_WIDTH,
        hostWidth - (FLOAT_MARGIN + dockWidth + GAP + next.width) - PANEL_MARGIN,
      )
      return fitPanelFrame(
        { ...prev, width: startEditorWidth + delta },
        { ...editorLimits, maxWidth: editorMaxWidth },
      )
    })
  }
  const endPaneResize = () => { paneDragRef.current = null }

  const beginEditorResize = (direction: ResizeDirection) => {
    const frame = frameOf(editorPanelRef.current)
    if (!frame) return
    editorDragRef.current = { direction, frame }
  }
  const moveEditorResize = (dx: number, dy: number) => {
    const drag = editorDragRef.current
    if (!drag) return
    setEditorFrame(resizePanelFrame(drag.frame, drag.direction, dx, dy, editorLimits))
  }
  const endEditorResize = () => { editorDragRef.current = null }

  const openFile = async (file: FileNode) => {
    if (file.type === 'directory') return
    const ext = file.extension ?? fileExt(file.name)
    if (ext && !TEXT_EXT.has(ext)) {
      toast.message('该文件不是文本文件', { description: file.name })
      return
    }
    // 分屏 / 窄侧栏里放不下「文件列表 + 编辑器」两个框：打开文件就收起列表，
    // 否则内容框会被裁在栏外（看起来像错位）。
    setPane(hostWidth - editorRight - PANEL_MARGIN >= EDITOR_MIN_WIDTH ? 'files' : null)
    const entry: EditorFile = { path: file.path, name: file.name, extension: ext }
    setTabs((prev) => (prev.some((t) => t.path === entry.path) ? prev : [...prev, entry]))
    setActivePath(entry.path)
    setEditorOpen(true)
    if (contents[entry.path] === undefined) {
      const ytext = doc ? getYText(doc, entry.path) : null
      const content = ytext?.toString() ?? await fetchFileContent(workspaceId!, entry.path).catch(() => '')
      setContents((prev) => ({ ...prev, [entry.path]: content }))
    }
  }

  const closeTab = (path: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== path)
      if (activePath === path) {
        setActivePath(next[next.length - 1]?.path ?? null)
        if (next.length === 0) setEditorOpen(false)
      }
      return next
    })
  }

  const save = async (path: string, content: string) => {
    try {
      const originalContent = contents[path] ?? content
      const result = await saveFileEntry(workspaceId!, { path, content, originalContent })
      if (result.conflict) {
        toast.error('文件已被外部修改，请重新打开后再保存')
      } else {
        setContents((prev) => ({ ...prev, [path]: content }))
        toast.success('已保存')
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    }
  }

  // 2026-11-01 dock 常驻：纯会话（没有 workspace）也挂坞，文件 / 活动降级为
  // 不可用，消耗 / 调试照常。否则「调试只放坞」在无工作区会话里没有入口。
  const active = tabs.find((t) => t.path === activePath) ?? null
  const status = task?.status ?? ''
  const isDraft = status === 'draft'
  // workflow-dev tasks are driven from the left chat: the dock exposes the
  // workflow editor + workspace runs, not the phase/spec/acceptance modules.
  const isWorkflowDev = task?.task_spec?.kind === 'workflow-dev'
  const hasExecution =
    !!task?.execution || isWorkflowDev || ['running', 'paused', 'awaiting_review', 'awaiting_archive', 'archiving', 'done'].includes(status)
  const visibleModules = task
    ? MODULE_ROWS.filter((row) => {
        switch (row.id) {
          case 'workflow':
            // 只有工作流开发任务有这个模块；普通任务连按钮都不出现。
            return isWorkflowDev
          case 'plan':
          case 'artifacts':
            return !isWorkflowDev
          case 'changes':
            return !isDraft && !isWorkflowDev
          case 'run':
            return hasExecution
          case 'acceptance':
            // 2026-10-30 用户：归档后验收台仍要在 —— 只读回看「我签了什么」，
            // 不用翻聊天记录；done 的窗口内容由 AcceptanceSurface 降级为台账。
            return !isWorkflowDev && (status === 'awaiting_review' || status === 'awaiting_archive' || status === 'archiving' || status === 'done')
          case 'archive':
            return status === 'archiving' || status === 'done'
          default:
            return true
        }
      })
    : []
  const statusMeta = task
    ? (TASK_STATUS_META[task.status] ?? { label: task.status, badge: 'bg-pop-dim text-pop-bg', icon: FileText })
    : null
  // 10-state action matrix (one primary + secondaries). Actions are delegated
  // to ChatTab's shared handler — the dock never re-implements a task endpoint.
  const taskActions: Array<{
    id: string
    label: string
    tone: 'green' | 'amber' | 'ghost'
    icon: LucideIcon
  }> =
    isWorkflowDev ? [] :
    status === 'draft' ? [{ id: 'enqueue', label: '入列', tone: 'green', icon: Upload }]
      : status === 'ready'
        ? [
            { id: 'trigger', label: '触发', tone: 'green', icon: Play },
            { id: 'schedule', label: '定时', tone: 'ghost', icon: Clock },
            { id: 'abort', label: '中止', tone: 'ghost', icon: Square },
          ]
        : status === 'running'
          ? [
              { id: 'pause', label: '暂停', tone: 'ghost', icon: Pause },
              { id: 'abort', label: '中止', tone: 'ghost', icon: Square },
            ]
          : status === 'paused'
            ? [
                { id: 'resume', label: '恢复', tone: 'green', icon: Play },
                { id: 'abort', label: '中止', tone: 'ghost', icon: Square },
              ]
            : status === 'awaiting_review'
              ? [{ id: 'open_acceptance', label: '去验收', tone: 'amber', icon: Check }]
              : status === 'awaiting_archive'
                ? [
                    { id: 'open_acceptance', label: '回看验收', tone: 'amber', icon: ClipboardCheck },
                    { id: 'abort', label: '中止', tone: 'ghost', icon: Square },
                  ]
                : status === 'archiving'
                ? [{ id: 'retry_archive', label: '重试归档', tone: 'amber', icon: Archive }]
                : status === 'done'
                  ? []
                  : [{ id: 'duplicate', label: '复制', tone: 'ghost', icon: Copy }]
  const phaseLabel =
    task?.execution?.phase_index != null
      ? `P${task.execution.phase_index}${task.execution.round_index != null ? ` · R${task.execution.round_index}` : ''}`
      : null
  const statusTitle = statusMeta
    ? [statusMeta.label, phaseLabel, task?.name].filter(Boolean).join(' · ')
    : undefined
  const StatusIcon = statusMeta?.icon ?? null
  // 常驻「消耗」按钮（2026-10-31）：文件 / 活动 / 消耗都是随时想看的读数，
  // 跟任务阶段无关 —— 任务窗与会话窗共用同一个模块 id。
  const usageOpen = !!usageWindow && !usageWindow.minimized
  const usageMinimized = !!usageWindow?.minimized
  const debugOpen = !!debugWindow && !debugWindow.minimized
  const debugMinimized = !!debugWindow?.minimized
  const subagentOpen = !!subagentWindow && !subagentWindow.minimized
  const subagentMinimized = !!subagentWindow?.minimized

  const dockButton = (
    key: string,
    label: string,
    Icon: typeof FileText,
    opts: {
      active?: boolean
      onClick: () => void
      badge?: number
      marker?: 'open' | 'minimized'
      primary?: boolean
      testId?: string
      module?: TaskModule
      pane?: Pane
      /** 坞内文字（≤3 字约定）；缺省用 label。 */
      shortLabel?: string
      /** 待你处理（待验收）—— 琥珀注意力态，窗口打开后让位 active。 */
      attention?: boolean
      /** 没有工作区时（纯会话）文件 / 活动不可用。 */
      disabled?: boolean
      /** 徽标底色：默认青（活动）；调试用琥珀（异常）；运行中运行数用绿；子代理用紫。 */
      badgeTone?: 'cyan' | 'amber' | 'green' | 'purple'
      /** 绿点：该入口正在记录（调试）。 */
      recording?: boolean
    },
  ) => (
    <button
      key={key}
      type="button"
      data-testid={opts.testId}
      data-dock-module={opts.module}
      data-dock-pane={opts.pane}
      aria-pressed={opts.active}
      aria-disabled={opts.disabled || undefined}
      aria-label={label}
      title={showLabels ? (opts.disabled ? `${label}（当前会话没有工作区）` : undefined) : label}
      onClick={opts.onClick}
      disabled={opts.disabled}
      className={cn(
        'relative flex shrink-0 flex-col items-center justify-center rounded-[11px] transition-all duration-150',
        showLabels ? 'w-11 gap-[3px] px-0.5 py-1' : 'size-9 hover:scale-105',
        opts.disabled
          ? 'cursor-not-allowed text-pop-dim/35'
          : opts.primary
            ? 'bg-pop-green text-pop-bg hover:opacity-90'
            : opts.active
              ? 'bg-white/[0.12] text-pop-ink'
              : opts.attention
                ? 'bg-pop-amber-soft text-pop-amber ring-1 ring-pop-amber/35 hover:bg-pop-amber-soft/80'
                : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
      )}
    >
      <Icon className={showLabels ? 'size-[17px]' : 'size-[18px]'} strokeWidth={1.8} />
      {showLabels && (
        <span className="max-w-full truncate text-[9px] font-medium leading-none tracking-tight">
          {opts.shortLabel ?? label}
        </span>
      )}
      {!!opts.badge && opts.badge > 0 && (
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full px-0.5 font-mono text-[8px] font-bold text-pop-bg',
            opts.badgeTone === 'amber' ? 'bg-pop-amber'
              : opts.badgeTone === 'green' ? 'bg-pop-green'
                : opts.badgeTone === 'purple' ? 'bg-pop-purple'
                  : 'bg-pop-cyan',
          )}
        >
          {opts.badge}
        </span>
      )}
      {opts.recording && (
        <span className="absolute left-1 top-1 size-1 rounded-full bg-pop-green shadow-[0_0_6px_var(--pop-green)]" />
      )}
      {opts.marker === 'open' && (
        <span className={cn('absolute size-1 rounded-full bg-pop-yellow', showLabels ? 'bottom-0.5 right-1' : '-bottom-0.5')} />
      )}
      {opts.marker === 'minimized' && (
        <span className={cn('absolute size-1 rounded-full bg-pop-amber', showLabels ? 'bottom-0.5 right-1' : '-bottom-0.5')} />
      )}
    </button>
  )

  return (
    <>
      {editorOpen && (
        <div
          ref={editorPanelRef}
          data-testid="editor-panel"
          className="absolute top-14 bottom-3 z-40 hidden flex-col overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg shadow-pop-lg lg:flex"
          style={{
            right: editorRight,
            width: editorWidth,
            ...(fittedEditorFrame ? { top: fittedEditorFrame.top, height: fittedEditorFrame.height } : {}),
          }}
        >
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-white/[0.06] px-2.5">
            <button
              type="button"
              aria-label="关闭编辑器"
              title="关闭"
              onClick={() => setEditorOpen(false)}
              className="group/light grid size-6 shrink-0 place-items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-pop-yellow"
            >
              <CloseLightGlyph />
            </button>
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
              {tabs.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => setActivePath(entry.path)}
                  className={cn(
                    'group/tab flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 text-[11px] transition-colors',
                    entry.path === activePath
                      ? 'bg-white/[0.08] text-pop-ink'
                      : 'text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
                  )}
                >
                  <span className="max-w-[160px] truncate">{entry.name}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`关闭 ${entry.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(entry.path)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.stopPropagation()
                        closeTab(entry.path)
                      }
                    }}
                    className="grid size-3.5 place-items-center rounded-full text-pop-dim/60 hover:bg-white/[0.08] hover:text-pop-ink"
                  >
                    <X className="size-2.5" />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {active ? (
              <TextEditorTab
                key={active.path}
                filePath={active.path}
                fileName={active.name}
                extension={active.extension}
                initialContent={contents[active.path] ?? ''}
                doc={doc}
                onSave={(path, content) => void save(path, content)}
              />
            ) : null}
          </div>
          <WindowResizeHandles
            directions={PANEL_RESIZE_DIRECTIONS}
            onStart={beginEditorResize}
            onMove={moveEditorResize}
            onEnd={endEditorResize}
          />
        </div>
      )}

      {pane && (
        <div
          ref={panePanelRef}
          data-testid="workspace-pane"
          data-pane={pane}
          className="absolute top-14 z-30 hidden flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-pop-paper/95 shadow-pop-lg backdrop-blur-xl lg:flex"
          style={{
            right: FLOAT_MARGIN + dockWidth + GAP,
            width: paneWidth,
            ...(activePaneFrame
              ? { top: activePaneFrame.top, height: activePaneFrame.height }
              : { height: 'min(700px, calc(100% - 160px))' }),
          }}
        >
          {pane === 'files' ? (
            <SidebarFileTree
              files={files}
              doc={doc}
              connected={connected}
              workspacePath={workspacePath ?? ''}
              onOpenDirectory={workspacePath ? () => void openDirectory() : undefined}
              selectedPath={activePath ?? undefined}
              onFileSelect={(file) => void openFile(file)}
            />
          ) : pane === 'run' ? (
            <RunPicker
              workspaceId={workspaceId}
              runs={runs}
              activeRunId={taskWindows?.run?.runTarget?.executionId ?? null}
              onPick={(run) => {
                setPane(null)
                onOpenRun?.(run)
              }}
              onOpenYaml={(run) => {
                onOpenYaml?.(run)
              }}
            />
          ) : pane === 'subagents' ? (
            <SubagentListPane
              sessionId={subagentSessionId ?? null}
              runs={subagents}
              activeAgentId={subagentWindow?.subagentTarget?.id ?? null}
              onPick={(run) => {
                setPane(null)
                onOpenSubagent?.(run)
              }}
            />
          ) : (
            <InspectorActivityPanel workspaceId={workspaceId} snapshot={activity} />
          )}
          <WindowResizeHandles
            directions={PANEL_RESIZE_DIRECTIONS}
            onStart={beginPaneResize}
            onMove={movePaneResize}
            onEnd={endPaneResize}
          />
        </div>
      )}

      {/* macOS-style Dock: vertical; icon + ≤3-char label (可关）。 */}
      <div
        ref={dockRef}
        data-testid="workspace-explorer-dock"
        className={cn(
          // 舱模式：dock 是模块导航，须压在舱浮窗层（z-40）之上（原型 dock z-65 > win-layer z-60）。
          'absolute right-3 top-14 hidden flex-col items-center gap-1 rounded-2xl border border-white/[0.10] bg-pop-paper/80 p-1.5 shadow-pop-lg backdrop-blur-xl lg:flex',
          cabinModules && cabinModules.length > 0 ? 'z-[65]' : 'z-30',
          className,
        )}
      >
        {statusMeta && StatusIcon && (
          <span
            role="img"
            aria-label={statusTitle}
            title={statusTitle}
            data-testid="dock-task-status"
            className={cn(
              'absolute -right-2 -top-2 grid size-5 place-items-center rounded-full border-2 border-pop-paper shadow-pop-sm',
              statusMeta.badge,
              statusMeta.pulse && 'animate-pulse',
            )}
          >
            <StatusIcon className="size-3" strokeWidth={2.6} />
          </span>
        )}
        {dockButton('pane:files', '文件', FolderTree, {
          active: pane === 'files',
          onClick: () => togglePane('files'),
          pane: 'files',
          testId: 'dock-files',
          disabled: !workspaceId,
        })}
        {dockButton('pane:activity', '后台活动', Activity, {
          active: pane === 'activity',
          onClick: () => togglePane('activity'),
          pane: 'activity',
          badge: activity.count,
          testId: 'dock-activity',
          shortLabel: '活动',
          disabled: !workspaceId,
        })}
        {/* 子代理（2026-11-04）：只有本会话派出过子代理时才出现；徽标 = 运行中数量。 */}
        {(subagents.length > 0 || subagentOpen || subagentMinimized) && dockButton('pane:subagents', '子代理', Users, {
          active: pane === 'subagents' || subagentOpen,
          onClick: () => togglePane('subagents'),
          pane: 'subagents',
          testId: 'dock-subagents',
          shortLabel: '子代理',
          badge: liveSubagentCount,
          badgeTone: 'purple',
          marker: subagentMinimized ? 'minimized' : subagentOpen ? 'open' : undefined,
        })}
        {/* 调试 = 唯一入口：作业坞常驻，不依赖某条消息。 */}
        {dockButton('debug', '调试', Bug, {
          active: debugOpen,
          onClick: () => onOpenDebug?.(),
          testId: 'dock-debug',
          badge: debugAnomalies,
          badgeTone: 'amber',
          recording: !!debugSessionId,
          marker: debugMinimized ? 'minimized' : debugOpen ? 'open' : undefined,
        })}
        {dockButton('usage', '消耗', BarChart3, {
          active: usageOpen,
          onClick: () => onOpenUsage?.(),
          testId: 'dock-usage',
          marker: usageMinimized ? 'minimized' : usageOpen ? 'open' : undefined,
        })}

        {cabinModules && cabinModules.length > 0 && (
          <>
            <div className="my-0.5 h-px w-6 bg-white/[0.12]" />
            {cabinModules.map((m) => dockButton(`cabin:${m.id}`, m.label, m.icon, {
              active: m.active,
              attention: m.attention,
              badge: m.badge,
              badgeTone: m.badgeTone,
              marker: m.marker,
              onClick: m.onClick,
              testId: `dock-cabin-${m.id}`,
            }))}
            {cabinMoreModules && cabinMoreModules.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  data-testid="dock-cabin-more"
                  aria-label="更多模块"
                  title="更多模块"
                  aria-expanded={cabinMoreOpen}
                  onClick={() => setCabinMoreOpen((v) => !v)}
                  className={cn(
                    'relative flex shrink-0 flex-col items-center justify-center rounded-[11px] transition-all duration-150',
                    showLabels ? 'w-11 gap-[3px] px-0.5 py-1' : 'size-9 hover:scale-105',
                    cabinMoreOpen ? 'bg-white/[0.12] text-pop-ink' : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
                  )}
                >
                  <LayoutGrid className={showLabels ? 'size-[17px]' : 'size-[18px]'} strokeWidth={1.8} />
                  {showLabels && (
                    <span className="max-w-full truncate text-[9px] font-medium leading-none tracking-tight">更多</span>
                  )}
                </button>
                {cabinMoreOpen && (
                  <div
                    data-testid="dock-cabin-more-grid"
                    className="absolute right-full top-0 z-50 mr-2 grid w-60 grid-cols-3 gap-1 rounded-2xl border border-white/[0.10] bg-pop-paper/95 p-2 shadow-pop-lg backdrop-blur-xl"
                  >
                    {cabinMoreModules.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-testid={`dock-cabin-${m.id}`}
                        aria-label={m.label}
                        title={m.label}
                        onClick={() => { setCabinMoreOpen(false); m.onClick() }}
                        className={cn(
                          'relative flex h-[52px] flex-col items-center justify-center gap-1 rounded-[10px] transition-colors',
                          m.active ? 'bg-white/[0.12] text-pop-ink' : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
                        )}
                      >
                        {!!m.badge && m.badge > 0 && (
                          <span className={cn(
                            'absolute right-1 top-1 grid min-w-3.5 place-items-center rounded-full px-0.5 font-mono text-[8px] font-bold text-pop-bg',
                            m.badgeTone === 'amber' ? 'bg-pop-amber'
                              : m.badgeTone === 'green' ? 'bg-pop-green'
                                : m.badgeTone === 'purple' ? 'bg-pop-purple'
                                  : 'bg-pop-cyan',
                          )}>
                            {m.badge}
                          </span>
                        )}
                        <m.icon className="size-[15px]" strokeWidth={1.8} />
                        <span className="text-[8.5px] font-medium leading-none">{m.label}</span>
                        {m.marker && (
                          <span className={cn(
                            'absolute bottom-1 right-1.5 size-1 rounded-full',
                            m.marker === 'minimized' ? 'bg-pop-amber' : 'bg-pop-green',
                          )} />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {task && <div className="my-0.5 h-px w-6 bg-white/[0.12]" />}

        {taskProject}

        {task && visibleModules.map(({ id, label, icon: Icon }) => {
          const record = taskWindows?.[id]
          const open = !!record && !record.minimized
          const minimized = !!record?.minimized
          // 运行入口是「列表」而不是「直接开窗」：先看这份空间一共有几次运行，
          // 系统工作流（验收规划）与任务轮次都在同一个列表里。
          if (id === 'run') {
            return dockButton('pane:run', label, Icon, {
              active: pane === 'run' || open,
              onClick: () => togglePane('run'),
              module: id,
              pane: 'run',
              testId: 'dock-run',
              badge: liveRunCount,
              badgeTone: 'green',
              marker: minimized ? 'minimized' : open ? 'open' : undefined,
            })
          }
          return dockButton(`task:${id}`, label, Icon, {
            active: open,
            attention: id === 'acceptance' && status === 'awaiting_review' && !open,
            onClick: () => onOpenTaskModule?.(id),
            module: id,
            testId: id === 'acceptance' ? 'dock-acceptance' : undefined,
            marker: minimized ? 'minimized' : open ? 'open' : undefined,
          })
        })}

        {task && taskActions.map((action) => {
          const Icon = action.icon
          return (
            <button
              key={action.id}
              type="button"
              data-testid={`task-action-${action.id}`}
              aria-label={action.label}
              title={showLabels ? undefined : action.label}
              onClick={() => onTaskAction?.(action.id)}
              className={cn(
                'flex shrink-0 flex-col items-center justify-center rounded-[11px] transition-opacity hover:opacity-90',
                showLabels ? 'w-11 gap-[3px] px-0.5 py-1' : 'size-9',
                action.tone === 'green'
                  ? 'bg-pop-green text-pop-bg'
                  : action.tone === 'amber'
                    ? 'bg-pop-amber text-pop-bg'
                    : 'border border-pop-bd text-pop-dim hover:text-pop-ink',
              )}
            >
              <Icon className={showLabels ? 'size-[17px]' : 'size-[18px]'} strokeWidth={2} />
              {showLabels && (
                <span className="max-w-full truncate text-[9px] font-medium leading-none tracking-tight">
                  {action.label}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </>
  )
}
