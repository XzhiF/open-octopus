'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
  Package,
  Pause,
  Pencil,
  Play,
  Square,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { FileNode } from '@/lib/types'
import { fetchFileContent, getWorkspace, openWorkspaceDirectory, saveFileEntry } from '@/lib/api-client'
import { listSessionDebugTurns } from '@/lib/agent/debug-api'
import { useYDoc, useYMap } from '@/lib/yjs-provider'
import { SidebarFileTree, ymapToFileNodes } from '@/components/workspace/sidebar-file-tree'
import { TextEditorTab, getYText } from '@/components/workspace/text-editor-tab'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { DialogResizeHandles } from '@/components/ui/dialog-resize'
import { useEscapeClose } from '@/lib/escape-stack'
import type { TaskView } from '@/lib/tasks-api'
import type { TaskModule, TaskWindowMap, TaskWindowRecord } from '@/components/chat-workbench/task-window-types'
import {
  InspectorActivityPanel,
  type ActivitySnapshot,
} from '@/components/chat-workbench/inspector-activity'
import { cn } from '@/lib/utils'
import { useDockLabelsVisible } from '@/hooks/use-dock-labels'

export interface WorkspaceExplorerDockProps {
  workspaceId: string | null
  workspaceName?: string
  task?: TaskView | null
  taskWindows?: TaskWindowMap
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
  onOpenTaskModule?: (module: TaskModule) => void
  /** Task action (trigger/pause/resume/abort/reopen/retry_archive/accept…). */
  onTaskAction?: (action: string) => void
  activity: ActivitySnapshot
  /** ChatTab 注入的任务维度控件（绑定项目 dock 形态，2026-10-28）：渲染在
   *  任务分隔线之后、模块图标之前。 */
  taskProject?: ReactNode
  /** Chat sidebar width (0 when collapsed) — the editor panel sizes around it. */
  sidebarWidth?: number
  className?: string
}

interface EditorFile {
  path: string
  name: string
  extension?: string
}

type Pane = 'files' | 'activity'

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
/** Dock footprint (p-1.5 + border) — icon-only vs. icon + permanent label. */
const DOCK_WIDTH_ICON = 48
const DOCK_WIDTH_LABEL = 59
const PANE_WIDTH = 300
const GAP = 8
const FLOAT_MARGIN = 12
const SIDEBAR_DEFAULT_WIDTH = 236

const MODULE_ROWS: Array<{ id: TaskModule; label: string; icon: typeof FileText }> = [
  { id: 'plan', label: '规格', icon: FileText },
  { id: 'changes', label: '变更', icon: GitCompare },
  { id: 'run', label: '运行', icon: Play },
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
  usageWindow,
  onOpenUsage,
  debugWindow,
  onOpenDebug,
  debugSessionId,
  debugRefreshKey,
  onOpenTaskModule,
  onTaskAction,
  activity,
  taskProject,
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  className,
}: WorkspaceExplorerDockProps) {
  const [pane, setPane] = useState<Pane | null>(null)
  const [tabs, setTabs] = useState<EditorFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [contents, setContents] = useState<Record<string, string>>({})
  const [debugAnomalies, setDebugAnomalies] = useState(0)
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
  // 图标下方的常驻文字（设置 → 外观 可隐藏）。
  const showLabels = useDockLabelsVisible()
  const dockWidth = showLabels ? DOCK_WIDTH_LABEL : DOCK_WIDTH_ICON
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  )
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

  const editorRight = FLOAT_MARGIN + dockWidth + GAP + (pane ? PANE_WIDTH : 0)
  const availableWidth = Math.max(
    EDITOR_MIN_WIDTH,
    viewportWidth - (viewportWidth >= 768 ? sidebarWidth : 0) - editorRight - 24,
  )
  const panelWidth = Math.max(EDITOR_MIN_WIDTH, Math.min(560, availableWidth))

  useEscapeClose(editorOpen, () => setEditorOpen(false), 30)
  useEscapeClose(!!pane, () => setPane(null), 10)

  const togglePane = (next: Pane) => setPane((prev) => (prev === next ? null : next))

  const openFile = async (file: FileNode) => {
    if (file.type === 'directory') return
    const ext = file.extension ?? fileExt(file.name)
    if (ext && !TEXT_EXT.has(ext)) {
      toast.message('该文件不是文本文件', { description: file.name })
      return
    }
    setPane('files')
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
  const hasExecution =
    !!task?.execution || ['running', 'paused', 'awaiting_review', 'awaiting_archive', 'archiving', 'done'].includes(status)
  const visibleModules = task
    ? MODULE_ROWS.filter((row) => {
        switch (row.id) {
          case 'plan':
          case 'artifacts':
            return true
          case 'changes':
            return !isDraft
          case 'run':
            return hasExecution
          case 'acceptance':
            // 2026-10-30 用户：归档后验收台仍要在 —— 只读回看「我签了什么」，
            // 不用翻聊天记录；done 的窗口内容由 AcceptanceSurface 降级为台账。
            return status === 'awaiting_review' || status === 'awaiting_archive' || status === 'archiving' || status === 'done'
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
      /** 徽标底色：默认青（活动）；调试用琥珀（异常）。 */
      badgeTone?: 'cyan' | 'amber'
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
            opts.badgeTone === 'amber' ? 'bg-pop-amber' : 'bg-pop-cyan',
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
          data-testid="editor-panel"
          className="absolute top-14 bottom-3 z-40 hidden flex-col overflow-hidden rounded-2xl border border-white/[0.10] bg-pop-bg shadow-pop-lg lg:flex"
          style={{ right: editorRight, width: panelWidth }}
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
          <DialogResizeHandles minWidth={EDITOR_MIN_WIDTH} minHeight={220} className="pointer-events-none absolute inset-0 z-20" />
        </div>
      )}

      {pane && (
        <div
          data-testid="workspace-pane"
          data-pane={pane}
          className="absolute top-14 z-30 hidden flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-pop-paper/95 shadow-pop-lg backdrop-blur-xl lg:flex"
          style={{
            right: FLOAT_MARGIN + dockWidth + GAP,
            width: PANE_WIDTH,
            height: 'min(700px, calc(100% - 160px))',
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
          ) : (
            <InspectorActivityPanel workspaceId={workspaceId} snapshot={activity} />
          )}
          <DialogResizeHandles minWidth={240} minHeight={180} className="pointer-events-none absolute inset-0 z-20" />
        </div>
      )}

      {/* macOS-style Dock: vertical; icon + ≤3-char label (可关）。 */}
      <div
        data-testid="workspace-explorer-dock"
        className={cn(
          'absolute right-3 top-14 z-30 hidden flex-col items-center gap-1 rounded-2xl border border-white/[0.10] bg-pop-paper/80 p-1.5 shadow-pop-lg backdrop-blur-xl lg:flex',
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
        {dockButton('usage', '消耗', BarChart3, {
          active: usageOpen,
          onClick: () => onOpenUsage?.(),
          testId: 'dock-usage',
          marker: usageMinimized ? 'minimized' : usageOpen ? 'open' : undefined,
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

        {task && <div className="my-0.5 h-px w-6 bg-white/[0.12]" />}

        {taskProject}

        {task && visibleModules.map(({ id, label, icon: Icon }) => {
          const record = taskWindows?.[id]
          const open = !!record && !record.minimized
          const minimized = !!record?.minimized
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
