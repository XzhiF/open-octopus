'use client'

import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import {
  Activity,
  Archive,
  Ban,
  Check,
  ClipboardCheck,
  FileText,
  FolderTree,
  GitCompare,
  Pause,
  Pencil,
  Play,
  Upload,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { FileNode } from '@/lib/types'
import { fetchFileContent, saveFileEntry } from '@/lib/api-client'
import { useYDoc, useYMap } from '@/lib/yjs-provider'
import { SidebarFileTree, ymapToFileNodes } from '@/components/workspace/sidebar-file-tree'
import { TextEditorTab, getYText } from '@/components/workspace/text-editor-tab'
import { CloseLightGlyph } from '@/components/ui/close-light'
import { DialogResizeHandles } from '@/components/ui/dialog-resize'
import { useEscapeClose } from '@/lib/escape-stack'
import type { TaskView } from '@/lib/tasks-api'
import type { TaskModule, TaskWindowMap } from '@/components/chat-workbench/task-window-types'
import {
  InspectorActivityPanel,
  type ActivitySnapshot,
} from '@/components/chat-workbench/inspector-activity'
import { cn } from '@/lib/utils'

export interface WorkspaceExplorerDockProps {
  workspaceId: string | null
  workspaceName?: string
  task?: TaskView | null
  taskWindows?: TaskWindowMap
  onOpenTaskModule?: (module: TaskModule) => void
  onEnqueue?: () => void
  enqueueBusy?: boolean
  activity: ActivitySnapshot
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
const DOCK_WIDTH = 48
const PANE_WIDTH = 300
const GAP = 8
const FLOAT_MARGIN = 12
const SIDEBAR_DEFAULT_WIDTH = 236

const MODULE_ROWS: Array<{ id: TaskModule; label: string; icon: typeof FileText }> = [
  { id: 'plan', label: '规格', icon: FileText },
  { id: 'changes', label: '变更', icon: GitCompare },
  { id: 'acceptance', label: '验收', icon: ClipboardCheck },
  { id: 'experts', label: '专家', icon: Users },
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
 * macOS-style vertical Dock on the right: icon-only, no labels, no tabs.
 * A file/activity pane opens to its left (closed by default); module icons
 * open task windows directly. The editor window aligns its top to the Dock.
 */
export function WorkspaceExplorerDock({
  workspaceId,
  workspaceName,
  task,
  taskWindows,
  onOpenTaskModule,
  onEnqueue,
  enqueueBusy,
  activity,
  sidebarWidth = SIDEBAR_DEFAULT_WIDTH,
  className,
}: WorkspaceExplorerDockProps) {
  const [pane, setPane] = useState<Pane | null>(null)
  const [tabs, setTabs] = useState<EditorFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [contents, setContents] = useState<Record<string, string>>({})
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

  const editorRight = FLOAT_MARGIN + DOCK_WIDTH + GAP + (pane ? PANE_WIDTH : 0)
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

  if (!workspaceId) return null
  const active = tabs.find((t) => t.path === activePath) ?? null
  const isDraft = task?.status === 'draft'
  const nonDraft = !!task && !isDraft
  const acceptanceStage = task?.status === 'awaiting_review' || task?.status === 'archiving'
  const visibleModules = MODULE_ROWS.filter((row) => {
    if (row.id === 'changes') return nonDraft
    if (row.id === 'acceptance') return acceptanceStage
    return true
  })
  const statusMeta = task
    ? (TASK_STATUS_META[task.status] ?? { label: task.status, badge: 'bg-pop-dim text-pop-bg', icon: FileText })
    : null
  const phaseLabel =
    task?.execution?.phase_index != null
      ? `P${task.execution.phase_index}${task.execution.round_index != null ? ` · R${task.execution.round_index}` : ''}`
      : null
  const statusTitle = statusMeta
    ? [statusMeta.label, phaseLabel, task?.name].filter(Boolean).join(' · ')
    : undefined
  const StatusIcon = statusMeta?.icon ?? null

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
    },
  ) => (
    <button
      key={key}
      type="button"
      data-testid={opts.testId}
      data-dock-module={opts.module}
      data-dock-pane={opts.pane}
      aria-pressed={opts.active}
      aria-label={label}
      title={label}
      onClick={opts.onClick}
      className={cn(
        'relative grid size-9 place-items-center rounded-[11px] transition-all duration-150 hover:scale-105',
        opts.primary
          ? 'bg-pop-green text-pop-bg hover:opacity-90'
          : opts.active
            ? 'bg-white/[0.12] text-pop-ink'
            : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
      )}
    >
      <Icon className="size-[18px]" strokeWidth={1.8} />
      {!!opts.badge && opts.badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-pop-cyan px-0.5 font-mono text-[8px] font-bold text-pop-bg">
          {opts.badge}
        </span>
      )}
      {opts.marker === 'open' && (
        <span className="absolute -bottom-0.5 size-1 rounded-full bg-pop-yellow" />
      )}
      {opts.marker === 'minimized' && (
        <span className="absolute -bottom-0.5 size-1 rounded-full bg-pop-amber" />
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
            right: FLOAT_MARGIN + DOCK_WIDTH + GAP,
            width: PANE_WIDTH,
            height: 'min(700px, calc(100% - 160px))',
          }}
        >
          {pane === 'files' ? (
            <SidebarFileTree
              files={files}
              doc={doc}
              connected={connected}
              workspacePath=""
              selectedPath={activePath ?? undefined}
              onFileSelect={(file) => void openFile(file)}
            />
          ) : (
            <InspectorActivityPanel workspaceId={workspaceId} snapshot={activity} />
          )}
          <DialogResizeHandles minWidth={240} minHeight={180} className="pointer-events-none absolute inset-0 z-20" />
        </div>
      )}

      {/* macOS-style Dock: icons only, vertical, no labels. */}
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
        })}
        {dockButton('pane:activity', '后台活动', Activity, {
          active: pane === 'activity',
          onClick: () => togglePane('activity'),
          pane: 'activity',
          badge: activity.count,
          testId: 'dock-activity',
        })}

        {task && <div className="my-0.5 h-px w-6 bg-white/[0.12]" />}

        {task && visibleModules.map(({ id, label, icon: Icon }) => {
          const record = taskWindows?.[id]
          const open = !!record && !record.minimized
          const minimized = !!record?.minimized
          return dockButton(`task:${id}`, label, Icon, {
            active: open,
            onClick: () => onOpenTaskModule?.(id),
            module: id,
            marker: minimized ? 'minimized' : open ? 'open' : undefined,
          })
        })}

        {task && isDraft && onEnqueue && (
          <button
            type="button"
            data-testid="task-enqueue"
            disabled={enqueueBusy}
            aria-label="入队执行"
            title="入队执行"
            onClick={onEnqueue}
            className={cn(
              'grid size-9 place-items-center rounded-[11px] bg-pop-green text-pop-bg transition-opacity hover:opacity-90',
              enqueueBusy && 'animate-pulse opacity-60',
            )}
          >
            <Upload className="size-[18px]" strokeWidth={2} />
          </button>
        )}
      </div>
    </>
  )
}
